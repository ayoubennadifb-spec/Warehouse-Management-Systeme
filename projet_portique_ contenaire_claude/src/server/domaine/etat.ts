/** Instantané complet de l'état courant, lu dans PostgreSQL (source de vérité). */
import type { Requeteur } from '../db.ts';
import { une, toutes } from '../db.ts';
import { calculerPlan } from '../../shared/geometrie.ts';
import { planActif } from './plans.ts';
import { listerMissions } from './missions.ts';

export async function dernierEvenementId(q: Requeteur): Promise<number> {
  return (await une(q, 'SELECT coalesce(max(id), 0) AS id FROM evenement')).id;
}

export async function lireEvenements(q: Requeteur, opts: { apres?: number; avant?: number; limite?: number }) {
  const limite = Math.min(Math.max(opts.limite ?? 100, 1), 1000);
  if (opts.apres !== undefined)
    return toutes(q, `SELECT * FROM evenement WHERE id > $1 ORDER BY id LIMIT $2`, [opts.apres, limite]);
  return toutes(q, `SELECT * FROM evenement WHERE ($1::bigint IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`, [opts.avant ?? null, limite]);
}

export async function chargerEtat(q: Requeteur) {
  // Lecture cohérente : une seule transaction en lecture seule (même instantané pour toutes les requêtes)
  const estPool = 'totalCount' in q;
  const c = estPool ? await (q as import('pg').Pool).connect() : q;
  try {
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const r = await lireEtatTransaction(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (estPool) (c as import('pg').PoolClient).release();
  }
}

export async function lireEtatTransaction(q: Requeteur) {
  const plan = await planActif(q);
  const dernier = await dernierEvenementId(q);
  let geometrie = null;
  if (plan) {
    const calc = calculerPlan(plan.parametres);
    geometrie = {
      zones: await toutes(q, `SELECT id, code, x_min_mm, x_max_mm, y_min_mm, y_max_mm FROM zone WHERE version_plan_id = $1`, [plan.id]),
      positions: await toutes(
        q,
        `SELECT id, ix, iy, code, centre_x_mm, centre_y_mm, statut, motif_blocage FROM position_sol WHERE version_plan_id = $1 ORDER BY ix, iy`,
        [plan.id],
      ),
      emplacements: await toutes(
        q,
        `SELECT id, code, position_sol_id, niveau, z_base_mm FROM emplacement WHERE version_plan_id = $1 ORDER BY position_sol_id, niveau`,
        [plan.id],
      ),
      postes: await toutes(
        q,
        `SELECT id, code, centre_x_mm, centre_y_mm, longueur_x_mm, largeur_y_mm, cote_cabine, statut, motif_indisponibilite
           FROM poste_transport WHERE version_plan_id = $1 ORDER BY code`,
        [plan.id],
      ),
      type_conteneur: await une(q, 'SELECT * FROM type_conteneur WHERE id = $1', [plan.type_conteneur_id]),
      type_camion: await une(q, 'SELECT * FROM type_camion WHERE id = $1', [plan.type_camion_id]),
      repartition_x: calc.repartition_x,
      repartition_y: calc.repartition_y,
      avertissements: calc.avertissements,
      hauteur_pile_max: calc.hauteur_pile_max,
    };
  }
  const conteneurs = await toutes(
    q,
    `SELECT l.id, l.code, l.etat, l.demo, l.emplacement_id, l.type_emplacement, l.code_emplacement, l.code_position,
            l.niveau, l.code_camion, l.code_poste, l.x_mm, l.y_mm, l.z_mm, l.mission_transfert_id, l.motif_incertitude,
            t.longueur_mm, t.largeur_mm, t.hauteur_mm
       FROM v_conteneur_localisation l JOIN conteneur c ON c.id = l.id JOIN type_conteneur t ON t.id = c.type_conteneur_id
      WHERE l.etat <> 'SORTI' ORDER BY l.code`,
  );
  const visites = await toutes(
    q,
    `SELECT v.id, v.arrivee_le, v.plateau_x_mm, v.plateau_y_mm, v.plateau_z_mm, v.code_conteneur_annonce,
            k.id AS camion_id, k.code AS camion_code, k.demo, pt.id AS poste_id, pt.code AS poste_code,
            pt.centre_x_mm, pt.centre_y_mm, pt.cote_cabine, e.id AS plateau_emplacement_id,
            tc.cabine_longueur_mm, tc.cabine_largeur_mm, tc.cabine_hauteur_mm,
            tc.plateau_longueur_mm, tc.plateau_largeur_mm, tc.plateau_hauteur_mm
       FROM visite_camion v JOIN camion k ON k.id = v.camion_id JOIN type_camion tc ON tc.id = k.type_camion_id
       JOIN poste_transport pt ON pt.id = v.poste_id LEFT JOIN emplacement e ON e.camion_id = k.id
      WHERE v.statut = 'PRESENTE' ORDER BY pt.code`,
  );
  const visites_recentes = await toutes(
    q,
    `SELECT v.id, v.statut, v.arrivee_le, v.depart_le, v.motif_refus, v.code_conteneur_annonce, k.code AS camion_code,
            pt.code AS poste_code, ca.code AS conteneur_arrivee, cd.code AS conteneur_depart
       FROM visite_camion v JOIN camion k ON k.id = v.camion_id LEFT JOIN poste_transport pt ON pt.id = v.poste_id
       LEFT JOIN conteneur ca ON ca.id = v.conteneur_arrivee_id LEFT JOIN conteneur cd ON cd.id = v.conteneur_depart_id
      ORDER BY v.id DESC LIMIT 20`,
  );
  const missions = await listerMissions(q, 60);
  const trajets = await toutes(
    q,
    `SELECT t.mission_id, t.version, t.algorithme, t.optimise, json_agg(json_build_object('x', p.x_mm, 'y', p.y_mm, 'z', p.z_mm, 'type', p.type) ORDER BY p.ordre) AS points
       FROM trajet t JOIN point_trajet p ON p.trajet_id = t.id
      WHERE t.statut IN ('PLANIFIE','EN_COURS') GROUP BY t.id`,
  );
  const reservations = await toutes(q, `SELECT emplacement_id, mission_id, role FROM reservation WHERE statut = 'ACTIVE'`);
  const unite = await une(q, `SELECT id, code, description, x_mm, y_mm, z_mm, position_le, source_position FROM unite_manutention ORDER BY id LIMIT 1`);
  const alertes = await toutes(q, `SELECT * FROM alerte WHERE statut <> 'RESOLUE' ORDER BY id DESC LIMIT 50`);
  const evenements = await toutes(q, `SELECT * FROM evenement ORDER BY id DESC LIMIT 60`);
  const versions = await toutes(
    q,
    `SELECT v.id, v.numero, v.libelle, v.statut, v.cree_le, v.active_le, v.archivee_le, v.parametres, c.nb_positions_sol, c.nb_emplacements, c.nb_postes
       FROM version_plan v JOIN v_capacite_plan c ON c.version_plan_id = v.id ORDER BY v.numero DESC`,
  );
  const enStockage = conteneurs.filter((c) => c.type_emplacement === 'CASE').length;
  const enCours = missions.filter((m) => m.statut === 'EN_COURS' || m.statut === 'SUSPENDUE').length;
  const indicateurs = plan
    ? {
        conteneurs_presents: conteneurs.length,
        conteneurs_stockage: enStockage,
        conteneurs_camions: conteneurs.filter((c) => c.type_emplacement === 'PLATEAU').length,
        conteneurs_transfert: conteneurs.filter((c) => c.etat === 'EN_TRANSFERT').length,
        conteneurs_incertains: conteneurs.filter((c) => c.etat === 'INCERTAINE').length,
        nb_conteneurs_max: plan.nb_conteneurs_max,
        perimetre_capacite: plan.perimetre_capacite,
        emplacements_total: geometrie!.emplacements.length,
        emplacements_occupes: enStockage,
        positions_sol_total: geometrie!.positions.length,
        postes_total: geometrie!.postes.length,
        postes_occupes: visites.length,
        postes_disponibles: geometrie!.postes.filter((p) => p.statut === 'DISPONIBLE' && !visites.some((v) => v.poste_id === p.id)).length,
        missions_en_cours: enCours,
        missions_en_attente: missions.filter((m) => m.statut === 'EN_ATTENTE').length,
        missions_interrompues: missions.filter((m) => m.statut === 'INTERROMPUE').length,
        alertes_ouvertes: alertes.length,
      }
    : null;
  return {
    operation: await une(q,'SELECT * FROM operation_degagement ORDER BY id DESC LIMIT 1'),
    genere_le: new Date().toISOString(),
    dernier_evenement_id: dernier,
    plan: plan ? { ...plan, geometrie } : null,
    conteneurs,
    visites,
    visites_recentes,
    missions,
    trajets,
    reservations,
    unite,
    alertes,
    evenements,
    versions,
    indicateurs,
    demo: conteneurs.some((c) => c.demo) || visites.some((v) => v.demo),
  };
}

export type Etat = Awaited<ReturnType<typeof chargerEtat>>;
