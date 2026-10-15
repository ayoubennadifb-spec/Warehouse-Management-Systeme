/**
 * Règles d'accessibilité : elles EXPLIQUENT pourquoi une source ou une destination est refusée.
 * Utilisées à la création des missions et pour l'affichage des destinations possibles.
 * (La base reste le dernier rempart : contraintes uniques + déclencheurs de 002.)
 */
import type { Requeteur } from '../db.ts';
import { toutes } from '../db.ts';
import { exigerPlanActif, type VersionPlan } from './plans.ts';

export interface Raison {
  code: string;
  message: string;
}

export interface EmplacementInfo {
  id: number;
  type: 'CASE' | 'PLATEAU';
  code: string;
  position_sol_id: number | null;
  position_code: string | null;
  niveau: number | null;
  position_statut: string | null;
  motif_blocage: string | null;
  camion_id: number | null;
  camion_code: string | null;
  poste_code: string | null;
}

export interface ConteneurInfo {
  id: number;
  code: string;
  etat: string;
  emplacement_id: number | null;
}

export interface Contexte {
  plan: VersionPlan;
  emplacements: Map<number, EmplacementInfo>;
  /** position_sol_id → niveau → emplacement */
  piles: Map<number, Map<number, EmplacementInfo>>;
  occupant: Map<number, ConteneurInfo>;
  reservation: Map<number, { mission_id: number; role: string }>;
  missionActive: Map<number, number>;
  conteneurs: Map<number, ConteneurInfo>;
  nbZone: number;
  nbStockage: number;
  /** missions non terminées qui ajouteront un conteneur au stockage (depuis un camion) */
  nbVersStockage: number;
}

export async function chargerContexte(q: Requeteur): Promise<Contexte> {
  const plan = await exigerPlanActif(q);
  const emps = await toutes<EmplacementInfo>(
    q,
    `SELECT e.id, e.type, e.code, e.position_sol_id, p.code AS position_code, e.niveau,
            p.statut AS position_statut, p.motif_blocage, NULL::int AS camion_id, NULL AS camion_code, NULL AS poste_code
       FROM emplacement e JOIN position_sol p ON p.id = e.position_sol_id
      WHERE e.version_plan_id = $1
     UNION ALL
     SELECT e.id, e.type, e.code, NULL, NULL, NULL, NULL, NULL, e.camion_id, k.code, pt.code
       FROM emplacement e
       JOIN visite_camion v ON v.camion_id = e.camion_id AND v.statut = 'PRESENTE'
       JOIN camion k ON k.id = e.camion_id
       JOIN poste_transport pt ON pt.id = v.poste_id`,
    [plan.id],
  );
  const conts = await toutes<ConteneurInfo>(q, `SELECT id, code, etat, emplacement_id FROM conteneur WHERE etat <> 'SORTI'`);
  const res = await toutes(q, `SELECT emplacement_id, mission_id, role FROM reservation WHERE statut = 'ACTIVE'`);
  const mis = await toutes(
    q,
    `SELECT m.id, m.conteneur_id, s.type AS st, d.type AS dt, m.depot_confirme_le FROM mission m
       JOIN emplacement s ON s.id = m.source_emplacement_id JOIN emplacement d ON d.id = m.destination_emplacement_id
      WHERE m.statut IN ('EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE')`,
  );
  const ctx: Contexte = {
    plan,
    emplacements: new Map(),
    piles: new Map(),
    occupant: new Map(),
    reservation: new Map(),
    missionActive: new Map(),
    conteneurs: new Map(),
    nbZone: conts.length,
    nbStockage: 0,
    nbVersStockage: mis.filter((m) => m.st === 'PLATEAU' && m.dt === 'CASE').length,
  };
  for (const e of emps) {
    ctx.emplacements.set(e.id, e);
    if (e.type === 'CASE') {
      if (!ctx.piles.has(e.position_sol_id!)) ctx.piles.set(e.position_sol_id!, new Map());
      ctx.piles.get(e.position_sol_id!)!.set(e.niveau!, e);
    }
  }
  for (const c of conts) {
    ctx.conteneurs.set(c.id, c);
    if (c.emplacement_id) {
      ctx.occupant.set(c.emplacement_id, c);
      if (ctx.emplacements.get(c.emplacement_id)?.type === 'CASE') ctx.nbStockage++;
    }
  }
  for (const r of res) ctx.reservation.set(r.emplacement_id, { mission_id: r.mission_id, role: r.role });
  for (const m of mis) ctx.missionActive.set(m.conteneur_id, m.id);
  return ctx;
}

/** Le conteneur peut-il être pris maintenant (au sommet, en place, libre) ? */
export function evaluerSource(ctx: Contexte, conteneurId: number): Raison[] {
  const c = ctx.conteneurs.get(conteneurId);
  if (!c) return [{ code: 'CONTENEUR_ABSENT', message: 'Ce conteneur n’est pas dans la zone.' }];
  const r: Raison[] = [];
  if (c.etat !== 'EN_PLACE') {
    const lib: Record<string, string> = {
      EN_TRANSFERT: 'il est déjà en cours de transfert',
      INCERTAINE: 'sa position est incertaine : déclarez d’abord sa position réelle',
    };
    r.push({ code: 'CONTENEUR_NON_EN_PLACE', message: `${c.code} ne peut pas être pris : ${lib[c.etat] ?? c.etat}.` });
    return r;
  }
  const m = ctx.missionActive.get(conteneurId);
  if (m) r.push({ code: 'CONTENEUR_DEJA_EN_MISSION', message: `${c.code} est déjà engagé dans la mission M${m}.` });
  const e = ctx.emplacements.get(c.emplacement_id!);
  if (!e) {
    r.push({ code: 'EMPLACEMENT_HORS_PLAN', message: `${c.code} est sur un emplacement hors du plan actif.` });
    return r;
  }
  if (e.type === 'CASE') {
    const pile = ctx.piles.get(e.position_sol_id!)!;
    const dessus: string[] = [];
    for (const [niv, em] of pile) {
      if (niv > e.niveau! && ctx.occupant.has(em.id)) dessus.push(ctx.occupant.get(em.id)!.code);
    }
    if (dessus.length)
      r.push({
        code: 'PAS_AU_SOMMET',
        message: `${c.code} n’est pas au sommet de la pile ${e.position_code} : déplacez d’abord ${dessus.join(', ')}.`,
      });
    const au = pile.get(e.niveau! + 1);
    if (au && !dessus.length && ctx.reservation.has(au.id))
      r.push({
        code: 'DESSUS_RESERVE',
        message: `Un dépôt est prévu au-dessus de ${c.code} (mission M${ctx.reservation.get(au.id)!.mission_id}).`,
      });
  }
  return r;
}

/** L'emplacement peut-il recevoir ce conteneur ? (vide ≠ utilisable) */
export function evaluerDestination(ctx: Contexte, conteneurId: number, emplacementId: number): Raison[] {
  const e = ctx.emplacements.get(emplacementId);
  if (!e) return [{ code: 'EMPLACEMENT_INCONNU', message: 'Emplacement inexistant dans le plan actif ou camion absent.' }];
  const c = ctx.conteneurs.get(conteneurId);
  const r: Raison[] = [];
  if (c?.emplacement_id === emplacementId) {
    r.push({ code: 'MEME_EMPLACEMENT', message: 'C’est l’emplacement actuel du conteneur.' });
    return r;
  }
  const occ = ctx.occupant.get(emplacementId);
  if (occ) r.push({ code: 'OCCUPE', message: `${e.code} est occupé par ${occ.code}.` });
  const res = ctx.reservation.get(emplacementId);
  if (res) r.push({ code: 'RESERVE', message: `${e.code} est réservé par la mission M${res.mission_id}.` });
  if (e.type === 'CASE') {
    if (e.position_statut === 'BLOQUEE')
      r.push({ code: 'POSITION_BLOQUEE', message: `La position ${e.position_code} est bloquée : ${e.motif_blocage}.` });
    if (e.niveau! > 1) {
      const dessous = ctx.piles.get(e.position_sol_id!)!.get(e.niveau! - 1)!;
      const support = ctx.occupant.get(dessous.id);
      if (!support) r.push({ code: 'SANS_SUPPORT', message: `${e.code} n’a pas de support : le niveau ${e.niveau! - 1} est vide.` });
      else if (support.id === conteneurId)
        r.push({ code: 'SUPPORT_EN_MISSION', message: `Le support de ${e.code} est le conteneur déplacé lui-même.` });
      else if (ctx.missionActive.has(support.id))
        r.push({
          code: 'SUPPORT_EN_MISSION',
          message: `Le support ${support.code} est engagé dans la mission M${ctx.missionActive.get(support.id)} et peut partir.`,
        });
    }
    const source = c?.emplacement_id ? ctx.emplacements.get(c.emplacement_id) : undefined;
    if (ctx.plan.perimetre_capacite === 'STOCKAGE' && source?.type === 'PLATEAU' && !occ) {
      if (ctx.nbStockage + ctx.nbVersStockage + 1 > ctx.plan.nb_conteneurs_max)
        r.push({
          code: 'CAPACITE',
          message: `Capacité du stockage atteinte (${ctx.plan.nb_conteneurs_max}, missions en attente comprises).`,
        });
    }
  }
  return r;
}

export function typeMission(src: EmplacementInfo, dst: EmplacementInfo): string {
  const s = src.type === 'CASE' ? 'STOCKAGE' : 'CAMION';
  const d = dst.type === 'CASE' ? 'STOCKAGE' : 'CAMION';
  return `${s}_VERS_${d}`;
}
