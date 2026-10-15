import type { Client, Requeteur } from '../db.ts';
import { une, toutes } from '../db.ts';
import { ErreurMetier } from '../erreurs.ts';
import { calculerPlan, codeEmplacement, type ParametresMaquette, type PlanCalcule } from '../../shared/geometrie.ts';
import { journaliser, ouvrirAlerte, type Source } from './journal.ts';

export interface VersionPlan {
  id: number;
  numero: number;
  libelle: string;
  statut: 'BROUILLON' | 'ACTIVE' | 'ARCHIVEE';
  nb_niveaux_max: number;
  nb_conteneurs_max: number;
  perimetre_capacite: 'ZONE' | 'STOCKAGE';
  type_conteneur_id: number;
  type_camion_id: number;
  parametres: ParametresMaquette;
  cree_le: string;
  active_le: string | null;
  archivee_le: string | null;
  commentaire: string | null;
}

export async function planActif(q: Requeteur): Promise<VersionPlan | null> {
  return une<VersionPlan>(q, `SELECT * FROM version_plan WHERE statut = 'ACTIVE'`);
}

export async function exigerPlanActif(q: Requeteur): Promise<VersionPlan> {
  const p = await planActif(q);
  if (!p) throw new ErreurMetier('AUCUN_PLAN_ACTIF', 'Aucune version de plan n’est active. Lancez « npm run db:seed » ou activez une version.', 409);
  return p;
}

async function typeConteneur(c: Client, p: ParametresMaquette): Promise<number> {
  const { longueur_mm: L, largeur_mm: W, hauteur_mm: H } = p.conteneur;
  await c.query(
    `INSERT INTO type_conteneur (code, longueur_mm, largeur_mm, hauteur_mm) VALUES ($1,$2,$3,$4)
     ON CONFLICT (longueur_mm, largeur_mm, hauteur_mm) DO NOTHING`,
    [`CONT-${L}x${W}x${H}`, L, W, H],
  );
  return (await une(c, `SELECT id FROM type_conteneur WHERE longueur_mm=$1 AND largeur_mm=$2 AND hauteur_mm=$3`, [L, W, H])).id;
}

async function typeCamion(c: Client, p: ParametresMaquette): Promise<number> {
  const k = p.camion;
  const v = [k.cabine_longueur_mm, k.cabine_largeur_mm, k.cabine_hauteur_mm, k.plateau_longueur_mm, k.plateau_largeur_mm, k.plateau_hauteur_mm];
  await c.query(
    `INSERT INTO type_camion (code, cabine_longueur_mm, cabine_largeur_mm, cabine_hauteur_mm,
                              plateau_longueur_mm, plateau_largeur_mm, plateau_hauteur_mm)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [`CAMION-${v.join('x')}`, ...v],
  );
  return (
    await une(
      c,
      `SELECT id FROM type_camion WHERE cabine_longueur_mm=$1 AND cabine_largeur_mm=$2 AND cabine_hauteur_mm=$3
         AND plateau_longueur_mm=$4 AND plateau_largeur_mm=$5 AND plateau_hauteur_mm=$6`,
      v,
    )
  ).id;
}

/** Vérifie les paramètres et enregistre une nouvelle version de plan (BROUILLON) avec toute sa géométrie. */
export async function creerVersion(
  c: Client,
  p: ParametresMaquette,
  source: Source,
  commentaire: string | null = null,
): Promise<{ id: number; numero: number; plan: PlanCalcule }> {
  const plan = calculerPlan(p);
  if (!plan.ok) {
    throw new ErreurMetier('PLAN_INVALIDE', `Paramètres refusés : ${plan.erreurs[0]}`, 422, { erreurs: plan.erreurs, avertissements: plan.avertissements });
  }
  const tc = await typeConteneur(c, p);
  const tk = await typeCamion(c, p);
  const numero = (await une(c, 'SELECT coalesce(max(numero), 0) + 1 AS n FROM version_plan')).n;
  const rx = plan.repartition_x!;
  const ry = plan.repartition_y!;
  const v = await une(
    c,
    `INSERT INTO version_plan (numero, libelle, espace_longueur_x_mm, espace_largeur_y_mm, transport_longueur_x_mm,
        transport_cote, nb_positions_x, nb_positions_y, nb_niveaux_max, marge_x_mm, espacement_x_mm, marge_y_mm,
        espacement_y_mm, nb_conteneurs_max, perimetre_capacite, type_conteneur_id, type_camion_id, parametres, commentaire)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [
      numero,
      p.libelle,
      p.espace.longueur_x_mm,
      p.espace.largeur_y_mm,
      p.zones.transport_longueur_x_mm,
      p.zones.transport_cote,
      p.grille.nb_positions_x,
      p.grille.nb_positions_y,
      p.grille.nb_niveaux_max,
      rx.marge_debut,
      rx.espacement,
      ry.marge_debut,
      ry.espacement,
      p.capacite.nb_conteneurs_max,
      p.capacite.perimetre,
      tc,
      tk,
      JSON.stringify(p),
      commentaire,
    ],
  );
  const id: number = v.id;
  const zoneIds: Record<string, number> = {};
  for (const z of plan.zones) {
    const r = await une(
      c,
      `INSERT INTO zone (version_plan_id, code, x_min_mm, x_max_mm, y_min_mm, y_max_mm) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [id, z.code, z.x_min, z.x_max, z.y_min, z.y_max],
    );
    zoneIds[z.code] = r.id;
  }
  const pos = await toutes(
    c,
    `INSERT INTO position_sol (version_plan_id, zone_id, ix, iy, code, centre_x_mm, centre_y_mm)
     SELECT $1, $2, * FROM unnest($3::smallint[], $4::smallint[], $5::text[], $6::numeric[], $7::numeric[])
     RETURNING id, ix, iy`,
    [
      id,
      zoneIds.STOCKAGE,
      plan.positions.map((x) => x.ix),
      plan.positions.map((x) => x.iy),
      plan.positions.map((x) => x.code),
      plan.positions.map((x) => x.centre_x),
      plan.positions.map((x) => x.centre_y),
    ],
  );
  const posIds: number[] = [];
  const niveaux: number[] = [];
  const z: number[] = [];
  const codes: string[] = [];
  for (const ps of pos) {
    for (const n of plan.niveaux) {
      posIds.push(ps.id);
      niveaux.push(n.niveau);
      z.push(n.z_base);
      codes.push(codeEmplacement(ps.ix, ps.iy, n.niveau));
    }
  }
  await c.query(
    `INSERT INTO emplacement (type, code, version_plan_id, position_sol_id, niveau, z_base_mm)
     SELECT 'CASE', code, $1, pid, niv, zb FROM unnest($2::text[], $3::int[], $4::smallint[], $5::numeric[]) AS t(code, pid, niv, zb)`,
    [id, codes, posIds, niveaux, z],
  );
  for (const ps of plan.postes) {
    await c.query(
      `INSERT INTO poste_transport (version_plan_id, zone_id, code, centre_x_mm, centre_y_mm, longueur_x_mm, largeur_y_mm, cote_cabine)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, zoneIds.TRANSPORT, ps.code, ps.centre_x, ps.centre_y, ps.longueur_x, ps.largeur_y, ps.cote_cabine],
    );
  }
  await journaliser(c, {
    type: 'PLAN_CREE',
    source,
    version_plan_id: id,
    message: `Version de plan n°${numero} enregistrée (brouillon) : ${plan.nb_positions_sol} positions, ${plan.nb_emplacements} emplacements, ${plan.postes.length} postes.`,
    donnees: { avertissements: plan.avertissements },
  });
  return { id, numero, plan };
}

export interface AnalyseActivation {
  version_id: number;
  possible: boolean;
  bloquants: string[];
  conserves: { conteneur: string; emplacement: string }[];
  impactes: { conteneur: string; emplacement: string; raison: string }[];
  incertains_existants: number;
}

/** Ce que deviendraient les conteneurs si la version était activée (aucune écriture). */
export async function analyserActivation(c: Requeteur, versionId: number): Promise<AnalyseActivation> {
  const v = await une<VersionPlan>(c, 'SELECT * FROM version_plan WHERE id = $1', [versionId]);
  if (!v) throw new ErreurMetier('VERSION_INCONNUE', `Version de plan ${versionId} introuvable.`, 404);
  const bloquants: string[] = [];
  if (v.statut !== 'BROUILLON') bloquants.push(`La version n°${v.numero} n’est pas un brouillon (${v.statut}).`);
  const k = await une(
    c,
    `SELECT (SELECT count(*) FROM mission WHERE statut IN ('EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE'))::int AS missions,
            (SELECT count(*) FROM reservation WHERE statut = 'ACTIVE')::int AS reservations,
            (SELECT count(*) FROM visite_camion WHERE statut = 'PRESENTE')::int AS camions,
            (SELECT count(*) FROM conteneur WHERE etat <> 'SORTI')::int AS zone,
            (SELECT count(*) FROM conteneur c JOIN emplacement e ON e.id = c.emplacement_id WHERE e.type = 'CASE')::int AS stockage,
            (SELECT count(*) FROM conteneur WHERE etat = 'INCERTAINE')::int AS incertains`,
  );
  if (k.missions) bloquants.push(`${k.missions} mission(s) non terminée(s) : terminez-les ou annulez-les.`);
  else if (k.reservations) bloquants.push(`${k.reservations} réservation(s) encore active(s) (positions incertaines à déclarer).`);
  if (k.camions) bloquants.push(`${k.camions} camion(s) présent(s) : faites-les partir avant de changer de plan.`);
  const occupes = v.perimetre_capacite === 'ZONE' ? k.zone : k.stockage;
  if (occupes > v.nb_conteneurs_max)
    bloquants.push(`Capacité insuffisante : ${occupes} conteneurs présents pour un maximum de ${v.nb_conteneurs_max}.`);

  const lignes = await toutes(
    c,
    `SELECT c.code, c.type_conteneur_id, e.code AS emp, p.centre_x_mm AS x, p.centre_y_mm AS y, e.z_base_mm AS z,
            ne.id AS nouvel_id, np.centre_x_mm AS nx, np.centre_y_mm AS ny, ne.z_base_mm AS nz
       FROM conteneur c
       JOIN emplacement e ON e.id = c.emplacement_id AND e.type = 'CASE'
       JOIN position_sol p ON p.id = e.position_sol_id
       LEFT JOIN position_sol np ON np.version_plan_id = $1 AND np.code = p.code
       LEFT JOIN emplacement ne ON ne.position_sol_id = np.id AND ne.niveau = e.niveau
      ORDER BY c.code`,
    [versionId],
  );
  const conserves: AnalyseActivation['conserves'] = [];
  const impactes: AnalyseActivation['impactes'] = [];
  for (const l of lignes) {
    let raison = '';
    if (!l.nouvel_id) raison = 'emplacement absent du nouveau plan';
    else if (Math.abs(l.x - l.nx) > 0.01 || Math.abs(l.y - l.ny) > 0.01 || Math.abs(l.z - l.nz) > 0.01)
      raison = `coordonnées modifiées (${l.x}, ${l.y}, ${l.z}) → (${l.nx}, ${l.ny}, ${l.nz}) mm`;
    else if (l.type_conteneur_id !== v.type_conteneur_id) raison = 'dimensions de conteneur différentes';
    if (raison) impactes.push({ conteneur: l.code, emplacement: l.emp, raison });
    else conserves.push({ conteneur: l.code, emplacement: l.emp });
  }
  return { version_id: versionId, possible: bloquants.length === 0, bloquants, conserves, impactes, incertains_existants: k.incertains };
}

/**
 * Active une version. Les conteneurs dont l'emplacement est physiquement identique sont rattachés
 * au nouveau plan (aucun déplacement fictif). Les autres : refus, ou — si forcer — passage en
 * position INCERTAINE avec leurs dernières coordonnées connues, à reconfirmer.
 */
export async function activerVersion(c: Client, versionId: number, opts: { forcer: boolean; source: Source }): Promise<AnalyseActivation> {
  const a = await analyserActivation(c, versionId);
  if (!a.possible) throw new ErreurMetier('ACTIVATION_IMPOSSIBLE', a.bloquants.join(' '), 409, a);
  if (a.impactes.length && !opts.forcer) {
    throw new ErreurMetier(
      'IMPACT_PLAN',
      `${a.impactes.length} conteneur(s) occupent des emplacements modifiés par ce plan. Déplacez-les, ou confirmez l’activation : ils passeront en position incertaine (aucun déplacement fictif).`,
      409,
      a,
    );
  }
  const ancien = await planActif(c);
  const nouveau = (await une(c, 'SELECT numero FROM version_plan WHERE id = $1', [versionId])).numero;
  if (ancien) await c.query(`UPDATE version_plan SET statut = 'ARCHIVEE', archivee_le = now() WHERE id = $1`, [ancien.id]);
  await c.query(`UPDATE version_plan SET statut = 'ACTIVE', active_le = now() WHERE id = $1`, [versionId]);

  // Rattachement administratif (même lieu physique) au nouveau plan
  await c.query(
    `UPDATE conteneur c SET emplacement_id = ne.id
       FROM emplacement e
       JOIN position_sol p ON p.id = e.position_sol_id
       JOIN position_sol np ON np.version_plan_id = $1 AND np.code = p.code
       JOIN emplacement ne ON ne.position_sol_id = np.id AND ne.niveau = e.niveau
      WHERE c.emplacement_id = e.id AND e.type = 'CASE' AND NOT (c.code = ANY($2::text[]))`,
    [versionId, a.impactes.map((i) => i.conteneur)],
  );
  for (const i of a.impactes) {
    const k = await une(
      c,
      `SELECT c.id, k.x, k.y, k.z FROM conteneur c, LATERAL coord_emplacement(c.emplacement_id) k WHERE c.code = $1`,
      [i.conteneur],
    );
    const r = await une(
      c,
      `UPDATE conteneur SET etat = 'INCERTAINE', emplacement_id = NULL, derniere_x_mm = $2, derniere_y_mm = $3,
              derniere_z_mm = $4, motif_incertitude = $5
        WHERE id = $1 RETURNING id`,
      [k.id, k.x, k.y, k.z, `Plan modifié (${i.raison}) : position à reconfirmer`],
    );
    await journaliser(c, {
      type: 'POSITION_INCERTAINE',
      source: opts.source,
      gravite: 'AVERTISSEMENT',
      conteneur_id: r.id,
      version_plan_id: versionId,
      message: `${i.conteneur} : position à reconfirmer après changement de plan (${i.raison}).`,
    });
    await ouvrirAlerte(c, {
      type: 'INCERTITUDE_POSITION',
      gravite: 'AVERTISSEMENT',
      conteneur_id: r.id,
      message: `${i.conteneur} : position à reconfirmer (changement de plan).`,
    });
  }
  if (ancien) {
    // L'état opérationnel (blocages) suit les positions de même code
    await c.query(
      `UPDATE position_sol np SET statut = op.statut, motif_blocage = op.motif_blocage
         FROM position_sol op WHERE op.version_plan_id = $1 AND op.statut = 'BLOQUEE'
          AND np.version_plan_id = $2 AND np.code = op.code`,
      [ancien.id, versionId],
    );
    await c.query(
      `UPDATE poste_transport np SET statut = op.statut, motif_indisponibilite = op.motif_indisponibilite
         FROM poste_transport op WHERE op.version_plan_id = $1 AND op.statut = 'HORS_SERVICE'
          AND np.version_plan_id = $2 AND np.code = op.code`,
      [ancien.id, versionId],
    );
  }
  await journaliser(c, {
    type: 'PLAN_ACTIVE',
    source: opts.source,
    version_plan_id: versionId,
    gravite: a.impactes.length ? 'AVERTISSEMENT' : 'INFO',
    message: `Version de plan n°${nouveau} activée${ancien ? ` (n°${ancien.numero} archivée)` : ''} : ${a.conserves.length} conteneur(s) conservé(s) à l’identique, ${a.impactes.length} à reconfirmer.`,
    donnees: { conserves: a.conserves.length, impactes: a.impactes },
  });
  return a;
}

