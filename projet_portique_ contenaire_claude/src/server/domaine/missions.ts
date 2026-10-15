/**
 * Missions de déplacement.
 *  - La DEMANDE ne modifie pas la position enregistrée : elle réserve source et destination.
 *  - La PRISE CONFIRMÉE fait passer le conteneur EN_TRANSFERT.
 *  - Le DÉPÔT CONFIRMÉ le place à destination et termine la mission.
 *  - Interruption / annulation après prise : le conteneur devient INCERTAIN (jamais remis
 *    automatiquement à son point de départ) ; source et destination restent réservées
 *    jusqu'à la déclaration de sa position réelle.
 */
import type { Client, Requeteur } from '../db.ts';
import { une, toutes } from '../db.ts';
import { ErreurMetier, traduireErreurPg } from '../erreurs.ts';
import { journaliser, ouvrirAlerte, resoudreAlertes, type Source } from './journal.ts';
import { chargerContexte, evaluerDestination, evaluerSource, typeMission } from './regles.ts';

export const STATUTS_ACTIFS = ['EN_ATTENTE', 'EN_COURS', 'SUSPENDUE', 'INTERROMPUE'];
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface MissionDetail {
  id: number;
  conteneur_id: number;
  conteneur_code: string;
  type: string;
  statut: string;
  source_emplacement_id: number;
  destination_emplacement_id: number;
  source_code: string;
  destination_code: string;
  demandee_le: string;
  demarree_le: string | null;
  prise_confirmee_le: string | null;
  depot_confirme_le: string | null;
  interrompue_le: string | null;
  terminee_le: string | null;
  motif_fin: string | null;
  executant: string | null;
}

const SQL_MISSION = `
  SELECT m.*, c.code AS conteneur_code, s.code AS source_code, d.code AS destination_code
    FROM mission m JOIN conteneur c ON c.id = m.conteneur_id
    JOIN emplacement s ON s.id = m.source_emplacement_id
    JOIN emplacement d ON d.id = m.destination_emplacement_id`;

export async function lireMission(q: Requeteur, id: number, verrouiller = false): Promise<MissionDetail> {
  const m = await une<MissionDetail>(q, `${SQL_MISSION} WHERE m.id = $1 ${verrouiller ? 'FOR UPDATE OF m' : ''}`, [id]);
  if (!m) throw new ErreurMetier('MISSION_INCONNUE', `Mission M${id} introuvable.`, 404);
  return m;
}

export async function listerMissions(q: Requeteur, limite = 50): Promise<MissionDetail[]> {
  return toutes<MissionDetail>(
    q,
    `${SQL_MISSION}
     ORDER BY (m.statut IN ('EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE')) DESC, m.id DESC LIMIT $1`,
    [limite],
  );
}

// ------------------------------------------------------------- unité de manutention
export async function unite(q: Requeteur): Promise<{ id: number; code: string; x_mm: number | null; y_mm: number | null; z_mm: number | null }> {
  const u = await une(q, `SELECT * FROM unite_manutention ORDER BY id LIMIT 1`);
  if (!u) throw new ErreurMetier('UNITE_ABSENTE', 'Aucune unité de manutention enregistrée (lancez npm run db:seed).', 409);
  return u;
}

export async function majPositionUnite(c: Client, p: Point3 | null | undefined, source: 'SIMULATION' | 'MATERIEL'): Promise<void> {
  if (!p) return;
  await c.query(
    `UPDATE unite_manutention SET x_mm = $1, y_mm = $2, z_mm = $3, position_le = now(), source_position = $4
      WHERE id = (SELECT id FROM unite_manutention ORDER BY id LIMIT 1)`,
    [p.x, p.y, p.z, source],
  );
}

async function libererReservations(c: Client, missionId: number, motif: string): Promise<void> {
  await c.query(
    `UPDATE reservation SET statut = 'LIBEREE', liberee_le = now(), motif_liberation = $2
      WHERE mission_id = $1 AND statut = 'ACTIVE'`,
    [missionId, motif],
  );
}

async function terminerTrajet(c: Client, missionId: number, statut: 'TERMINE' | 'ABANDONNE'): Promise<void> {
  await c.query(`UPDATE trajet SET statut = $2 WHERE mission_id = $1 AND statut IN ('PLANIFIE','EN_COURS')`, [missionId, statut]);
}

// ------------------------------------------------------------- création
export async function creerMission(
  c: Client,
  d: { conteneur_id: number; destination_emplacement_id: number },
  source: Source,
): Promise<MissionDetail> {
  const ctx = await chargerContexte(c);
  const raisons = [...evaluerSource(ctx, d.conteneur_id), ...evaluerDestination(ctx, d.conteneur_id, d.destination_emplacement_id)];
  if (raisons.length) throw new ErreurMetier('MISSION_REFUSEE', raisons.map((r) => r.message).join(' '), 409, { raisons });
  const cont = ctx.conteneurs.get(d.conteneur_id)!;
  const src = ctx.emplacements.get(cont.emplacement_id!)!;
  const dst = ctx.emplacements.get(d.destination_emplacement_id)!;
  const m = await une(
    c,
    `INSERT INTO mission (conteneur_id, type, source_emplacement_id, destination_emplacement_id, origine, version_plan_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [d.conteneur_id, typeMission(src, dst), src.id, dst.id, source === 'SYSTEME' ? 'SYSTEME' : 'OPERATEUR', ctx.plan.id],
  );
  await c.query(
    `INSERT INTO reservation (mission_id, emplacement_id, role) VALUES ($1,$2,'SOURCE'), ($1,$3,'DESTINATION')`,
    [m.id, src.id, dst.id],
  );
  await journaliser(c, {
    type: 'MISSION_CREEE',
    source,
    mission_id: m.id,
    conteneur_id: d.conteneur_id,
    message: `Mission M${m.id} demandée : ${cont.code} de ${src.code} vers ${dst.code} (position enregistrée inchangée).`,
  });
  return lireMission(c, m.id);
}

// ------------------------------------------------------------- exécution
export async function demarrerMission(c: Client, id: number, executant: 'SIMULATION' | 'MATERIEL'): Promise<MissionDetail> {
  const m = await lireMission(c, id, true);
  if (m.statut !== 'EN_ATTENTE') throw new ErreurMetier('TRANSITION_INVALIDE', `M${id} ne peut pas démarrer (statut ${m.statut}).`);
  const u = await unite(c);
  await c.query(
    `UPDATE mission SET statut = 'EN_COURS', demarree_le = now(), unite_manutention_id = $2, executant = $3 WHERE id = $1`,
    [id, u.id, executant],
  );
  await journaliser(c, { type: 'MISSION_DEMARREE', source: executant, mission_id: id, conteneur_id: m.conteneur_id, message: `M${id} démarrée (${m.conteneur_code}).` });
  return lireMission(c, id);
}

export interface DemandeConfirmation {
  source: 'SIMULATION' | 'MATERIEL';
  cle: string;
  type: 'PRISE' | 'DEPOT';
  mission_id: number;
  horodatage_source?: string | null;
  position?: Point3 | null;
}

export interface ResultatConfirmation {
  confirmation_id: number;
  resultat: 'APPLIQUEE' | 'REJETEE';
  deja_recue: boolean;
  motif?: string | null;
}

/** Applique une confirmation de prise ou de dépôt, une seule fois par (source, clé). */
export async function confirmer(c: Client, d: DemandeConfirmation): Promise<ResultatConfirmation> {
  const deja = await une(c, `SELECT id, resultat, motif_rejet FROM confirmation WHERE source = $1 AND cle_idempotence = $2`, [d.source, d.cle]);
  if (deja) return { confirmation_id: deja.id, resultat: deja.resultat, deja_recue: true, motif: deja.motif_rejet };
  if (!(await une(c, 'SELECT 1 FROM mission WHERE id = $1', [d.mission_id])))
    throw new ErreurMetier('MISSION_INCONNUE', `Mission M${d.mission_id} introuvable.`, 404);
  await c.query('SAVEPOINT conf');
  try {
    const conf = await une(
      c,
      `INSERT INTO confirmation (source, cle_idempotence, type, mission_id, horodatage_source, resultat, donnees)
       VALUES ($1,$2,$3,$4,$5,'APPLIQUEE',$6) RETURNING id`,
      [d.source, d.cle, d.type, d.mission_id, d.horodatage_source ?? null, JSON.stringify({ position: d.position ?? null })],
    );
    if (d.type === 'PRISE') await appliquerPrise(c, d, conf.id);
    else await appliquerDepot(c, d, conf.id);
    // Vérifie MAINTENANT les contraintes différées (empilement, capacité…) pour pouvoir tracer un rejet.
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    await c.query('RELEASE SAVEPOINT conf');
    return { confirmation_id: conf.id, resultat: 'APPLIQUEE', deja_recue: false };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT conf');
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    const t = traduireErreurPg(e);
    const motif = t instanceof ErreurMetier ? t.message : `Erreur : ${(e as Error).message}`;
    const conf = await une(
      c,
      `INSERT INTO confirmation (source, cle_idempotence, type, mission_id, horodatage_source, resultat, motif_rejet)
       VALUES ($1,$2,$3,$4,$5,'REJETEE',$6) RETURNING id`,
      [d.source, d.cle, d.type, d.mission_id, d.horodatage_source ?? null, motif],
    );
    await journaliser(c, {
      type: 'CONFIRMATION_REJETEE',
      source: d.source,
      gravite: 'AVERTISSEMENT',
      mission_id: d.mission_id,
      confirmation_id: conf.id,
      message: `Confirmation ${d.type} rejetée pour M${d.mission_id} : ${motif}`,
    });
    return { confirmation_id: conf.id, resultat: 'REJETEE', deja_recue: false, motif };
  }
}

async function appliquerPrise(c: Client, d: DemandeConfirmation, confId: number): Promise<void> {
  const m = await lireMission(c, d.mission_id, true);
  if (m.statut !== 'EN_COURS') throw new ErreurMetier('TRANSITION_INVALIDE', `M${m.id} n’est pas en cours (${m.statut}).`);
  if (m.prise_confirmee_le) throw new ErreurMetier('TRANSITION_INVALIDE', `La prise de M${m.id} est déjà confirmée.`);
  const cont = await une(c, 'SELECT * FROM conteneur WHERE id = $1 FOR UPDATE', [m.conteneur_id]);
  if (cont.etat !== 'EN_PLACE' || cont.emplacement_id !== m.source_emplacement_id)
    throw new ErreurMetier('ETAT_INCOHERENT', `${cont.code} n’est plus enregistré à ${m.source_code}.`);
  await c.query(`UPDATE conteneur SET etat = 'EN_TRANSFERT', emplacement_id = NULL, mission_transfert_id = $2 WHERE id = $1`, [cont.id, m.id]);
  await c.query(`UPDATE mission SET prise_confirmee_le = now() WHERE id = $1`, [m.id]);
  await majPositionUnite(c, d.position, d.source);
  await journaliser(c, {
    type: 'PRISE_CONFIRMEE',
    source: d.source,
    horodatage_source: d.horodatage_source,
    mission_id: m.id,
    conteneur_id: cont.id,
    emplacement_id: m.source_emplacement_id,
    confirmation_id: confId,
    message: `Prise confirmée : ${cont.code} quitte ${m.source_code} et passe en transfert (M${m.id}).`,
  });
}

async function appliquerDepot(c: Client, d: DemandeConfirmation, confId: number): Promise<void> {
  const m = await lireMission(c, d.mission_id, true);
  if (m.statut !== 'EN_COURS') throw new ErreurMetier('TRANSITION_INVALIDE', `M${m.id} n’est pas en cours (${m.statut}).`);
  if (!m.prise_confirmee_le) throw new ErreurMetier('TRANSITION_INVALIDE', `Dépôt impossible : la prise de M${m.id} n’est pas confirmée.`);
  const cont = await une(c, 'SELECT * FROM conteneur WHERE id = $1 FOR UPDATE', [m.conteneur_id]);
  if (cont.etat !== 'EN_TRANSFERT' || cont.mission_transfert_id !== m.id)
    throw new ErreurMetier('ETAT_INCOHERENT', `${cont.code} n’est pas en transfert pour M${m.id}.`);
  await c.query(`UPDATE conteneur SET etat = 'EN_PLACE', emplacement_id = $2, mission_transfert_id = NULL WHERE id = $1`, [
    cont.id,
    m.destination_emplacement_id,
  ]);
  await c.query(`UPDATE mission SET statut = 'TERMINEE', depot_confirme_le = now(), terminee_le = now() WHERE id = $1`, [m.id]);
  await libererReservations(c, m.id, 'Mission terminée');
  await terminerTrajet(c, m.id, 'TERMINE');
  await majPositionUnite(c, d.position, d.source);
  await journaliser(c, {
    type: 'DEPOT_CONFIRME',
    source: d.source,
    horodatage_source: d.horodatage_source,
    mission_id: m.id,
    conteneur_id: cont.id,
    emplacement_id: m.destination_emplacement_id,
    confirmation_id: confId,
    message: `Dépôt confirmé : ${cont.code} est à ${m.destination_code}. Mission M${m.id} terminée.`,
  });
}

// ------------------------------------------------------------- suspension / reprise / interruption / annulation
export async function suspendre(c: Client, id: number, source: Source, position?: Point3 | null): Promise<MissionDetail> {
  const m = await lireMission(c, id, true);
  if (m.statut !== 'EN_COURS') throw new ErreurMetier('TRANSITION_INVALIDE', `M${id} n’est pas en cours (${m.statut}).`);
  await c.query(`UPDATE mission SET statut = 'SUSPENDUE' WHERE id = $1`, [id]);
  if (source === 'SIMULATION' || source === 'MATERIEL') await majPositionUnite(c, position, source);
  await journaliser(c, { type: 'MISSION_SUSPENDUE', source, mission_id: id, conteneur_id: m.conteneur_id, message: `M${id} suspendue.` });
  return lireMission(c, id);
}

export async function reprendre(c: Client, id: number, source: Source, opts: { conteneur_toujours_tenu?: boolean } = {}): Promise<MissionDetail> {
  const m = await lireMission(c, id, true);
  if (m.statut === 'SUSPENDUE') {
    await c.query(`UPDATE mission SET statut = 'EN_COURS' WHERE id = $1`, [id]);
  } else if (m.statut === 'INTERROMPUE') {
    if (m.prise_confirmee_le) {
      if (!opts.conteneur_toujours_tenu)
        throw new ErreurMetier(
          'CONFIRMATION_REQUISE',
          `Reprise de M${id} : confirmez que ${m.conteneur_code} est toujours tenu par l’unité de manutention, ou déclarez sa position réelle.`,
          409,
        );
      const cont = await une(c, 'SELECT * FROM conteneur WHERE id = $1 FOR UPDATE', [m.conteneur_id]);
      if (cont.etat !== 'INCERTAINE') throw new ErreurMetier('ETAT_INCOHERENT', `${cont.code} n’est plus en position incertaine.`);
      await c.query(
        `UPDATE conteneur SET etat = 'EN_TRANSFERT', mission_transfert_id = $2, motif_incertitude = NULL WHERE id = $1`,
        [cont.id, id],
      );
    }
    const u = await unite(c);
    await c.query(`UPDATE mission SET statut = 'EN_COURS', interrompue_le = NULL, motif_fin = NULL, unite_manutention_id = $2 WHERE id = $1`, [id, u.id]);
    await resoudreAlertes(c, { mission_id: id, conteneur_id: m.conteneur_id });
  } else {
    throw new ErreurMetier('TRANSITION_INVALIDE', `M${id} ne peut pas reprendre (statut ${m.statut}).`);
  }
  await journaliser(c, { type: 'MISSION_REPRISE', source, mission_id: id, conteneur_id: m.conteneur_id, message: `M${id} reprise.` });
  return lireMission(c, id);
}

async function rendreIncertain(c: Client, conteneurId: number, missionId: number, motif: string, position?: Point3 | null): Promise<void> {
  const u = await unite(c);
  const p = position ?? (u.x_mm !== null ? { x: u.x_mm, y: u.y_mm!, z: u.z_mm! } : null);
  await c.query(
    `UPDATE conteneur SET etat = 'INCERTAINE', mission_transfert_id = NULL, motif_incertitude = $2,
            derniere_x_mm = $3, derniere_y_mm = $4, derniere_z_mm = $5
      WHERE id = $1 AND etat = 'EN_TRANSFERT' AND mission_transfert_id = $6`,
    [conteneurId, motif, p?.x ?? null, p?.y ?? null, p?.z ?? null, missionId],
  );
}

export async function interrompre(c: Client, id: number, motif: string, source: Source, position?: Point3 | null): Promise<MissionDetail> {
  const m = await lireMission(c, id, true);
  if (m.statut !== 'EN_COURS' && m.statut !== 'SUSPENDUE')
    throw new ErreurMetier('TRANSITION_INVALIDE', `M${id} ne peut pas être interrompue (statut ${m.statut}).`);
  await c.query(`UPDATE mission SET statut = 'INTERROMPUE', interrompue_le = now(), motif_fin = $2 WHERE id = $1`, [id, motif]);
  await terminerTrajet(c, id, 'ABANDONNE');
  if (source === 'SIMULATION' || source === 'MATERIEL') await majPositionUnite(c, position, source);
  const apresPrise = !!m.prise_confirmee_le;
  if (apresPrise) await rendreIncertain(c, m.conteneur_id, id, `Mission M${id} interrompue après la prise : ${motif}`, position);
  const msg = apresPrise
    ? `M${id} interrompue (${motif}). ${m.conteneur_code} était en transfert : position INCERTAINE, à confirmer avant toute reprise.`
    : `M${id} interrompue (${motif}) avant la prise : ${m.conteneur_code} est toujours à ${m.source_code}.`;
  await ouvrirAlerte(c, { type: 'MISSION_INTERROMPUE', gravite: 'CRITIQUE', mission_id: id, conteneur_id: m.conteneur_id, message: msg });
  await journaliser(c, { type: 'MISSION_INTERROMPUE', source, gravite: 'ALERTE', mission_id: id, conteneur_id: m.conteneur_id, message: msg });
  return lireMission(c, id);
}

export async function annuler(c: Client, id: number, motif: string, source: Source, position?: Point3 | null): Promise<MissionDetail> {
  const m = await lireMission(c, id, true);
  if (!STATUTS_ACTIFS.includes(m.statut)) throw new ErreurMetier('TRANSITION_INVALIDE', `M${id} est déjà ${m.statut}.`);
  await c.query(`UPDATE mission SET statut = 'ANNULEE', terminee_le = now(), motif_fin = $2 WHERE id = $1`, [id, motif]);
  await terminerTrajet(c, id, 'ABANDONNE');
  let msg: string;
  if (!m.prise_confirmee_le) {
    await libererReservations(c, id, 'Mission annulée avant la prise');
    await resoudreAlertes(c, { mission_id: id });
    msg = `M${id} annulée avant la prise : ${m.conteneur_code} reste à ${m.source_code}.`;
  } else {
    // Après la prise : pas de retour fictif au départ.
    await rendreIncertain(c, m.conteneur_id, id, `Mission M${id} annulée après la prise : position à déclarer`, position);
    msg = `M${id} annulée après la prise : ${m.conteneur_code} n’est PAS remis à ${m.source_code} ; sa position est incertaine et doit être déclarée. ${m.source_code} et ${m.destination_code} restent réservés jusque-là.`;
    await ouvrirAlerte(c, { type: 'INCERTITUDE_POSITION', gravite: 'AVERTISSEMENT', mission_id: id, conteneur_id: m.conteneur_id, message: msg });
  }
  await journaliser(c, {
    type: 'MISSION_ANNULEE',
    source,
    gravite: m.prise_confirmee_le ? 'AVERTISSEMENT' : 'INFO',
    mission_id: id,
    conteneur_id: m.conteneur_id,
    message: `${msg} Motif : ${motif}.`,
  });
  return lireMission(c, id);
}

// ------------------------------------------------------------- trajets (simulation ou futur algorithme)
export async function enregistrerTrajet(
  c: Client,
  missionId: number,
  points: (Point3 & { type: string })[],
  meta: { algorithme: string; motif: string; duree_estimee_s?: number },
): Promise<{ id: number; version: number }> {
  await c.query(`UPDATE trajet SET statut = 'REMPLACE' WHERE mission_id = $1 AND statut IN ('PLANIFIE','EN_COURS')`, [missionId]);
  const prec = await une(c, `SELECT id, version FROM trajet WHERE mission_id = $1 ORDER BY version DESC LIMIT 1`, [missionId]);
  let longueur = 0;
  for (let i = 1; i < points.length; i++)
    longueur += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y, points[i].z - points[i - 1].z);
  const t = await une(
    c,
    `INSERT INTO trajet (mission_id, version, algorithme, optimise, statut, motif_calcul, remplace_trajet_id, longueur_mm, duree_estimee_s)
     VALUES ($1,$2,$3,false,'EN_COURS',$4,$5,$6,$7) RETURNING id, version`,
    [missionId, (prec?.version ?? 0) + 1, meta.algorithme, meta.motif, prec?.id ?? null, Math.round(longueur * 100) / 100, meta.duree_estimee_s ?? null],
  );
  await c.query(
    `INSERT INTO point_trajet (trajet_id, ordre, x_mm, y_mm, z_mm, type)
     SELECT $1, o - 1, x, y, z, ty FROM unnest($2::numeric[], $3::numeric[], $4::numeric[], $5::text[]) WITH ORDINALITY AS t(x, y, z, ty, o)`,
    [t.id, points.map((p) => p.x), points.map((p) => p.y), points.map((p) => p.z), points.map((p) => p.type)],
  );
  return t;
}
