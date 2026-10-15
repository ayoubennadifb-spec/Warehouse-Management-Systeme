/**
 * Jeu de données de DÉMONSTRATION (déterministe, sans aléatoire).
 * Il NE représente PAS le mapping réel de la maquette : tous les objets sont marqués demo = true
 * et leurs codes commencent par « DEMO ».
 */
import type pg from 'pg';
import { transaction, une } from './db.ts';
import { configSimulation, parametresParDefaut } from './config.ts';
import type { ParametresMaquette } from '../shared/geometrie.ts';
import { activerVersion, creerVersion } from './domaine/plans.ts';
import { arriveeCamion } from './domaine/camions.ts';
import { journaliser } from './domaine/journal.ts';

/** Hauteur de pile de démonstration pour la position (ix, iy) : motif fixe 0..3. */
export function hauteurDemo(ix: number, iy: number, niveauxMax: number): number {
  const motif = [1, 0, 2, 0, 3, 0, 0]; // 42 places sur 49 positions, plafonné à 40
  return Math.min(motif[(ix * 3 + iy * 5) % motif.length], niveauxMax);
}

export async function semerDemo(
  pool: pg.Pool,
  opts: { params?: ParametresMaquette; maxStockage?: number; planSeulement?: boolean } = {},
): Promise<{ conteneurs: number }> {
  const params = opts.params ?? parametresParDefaut();
  const sim = configSimulation();
  return transaction(pool, async (c) => {
    if (await une(c, 'SELECT 1 FROM version_plan LIMIT 1')) throw new Error('La base contient déjà des données : utilisez « npm run db:reset -- --oui ».');
    const v = await creerVersion(c, params, 'SYSTEME', 'Version initiale créée par le jeu de démonstration');
    await activerVersion(c, v.id, { forcer: false, source: 'SYSTEME' });
    const zPassage = params.grille.nb_niveaux_max * params.conteneur.hauteur_mm + sim.degagement_mm;
    await c.query(
      `INSERT INTO unite_manutention (code, description, x_mm, y_mm, z_mm, position_le, source_position)
       VALUES ('UM-1', 'Unité de manutention ABSTRAITE : le mécanisme (levage, guidage, préhension) n''est pas encore choisi.', $1, $2, $3, now(), 'SIMULATION')`,
      [sim.position_repos.x_mm, sim.position_repos.y_mm, zPassage],
    );
    if (opts.planSeulement) return { conteneurs: 0 }; // inventaire réel à saisir
    const plan = await une(c, `SELECT * FROM version_plan WHERE id = $1`, [v.id]);
    const max = Math.min(opts.maxStockage ?? 40, plan.nb_conteneurs_max - 2);
    let n = 0;
    for (let ix = 1; ix <= params.grille.nb_positions_x && n < max; ix++) {
      for (let iy = 1; iy <= params.grille.nb_positions_y && n < max; iy++) {
        const h = hauteurDemo(ix, iy, params.grille.nb_niveaux_max);
        for (let niv = 1; niv <= h && n < max; niv++) {
          n++;
          await c.query(
            `INSERT INTO conteneur (code, type_conteneur_id, etat, emplacement_id, demo)
             SELECT $1, $2, 'EN_PLACE', e.id, true FROM emplacement e
               JOIN position_sol p ON p.id = e.position_sol_id
              WHERE p.version_plan_id = $3 AND p.ix = $4 AND p.iy = $5 AND e.niveau = $6`,
            [`DEMO-${String(n).padStart(3, '0')}`, plan.type_conteneur_id, v.id, ix, iy, niv],
          );
        }
      }
    }
    await journaliser(c, {
      type: 'INVENTAIRE_DEMO',
      source: 'SYSTEME',
      version_plan_id: v.id,
      message: `Jeu de DÉMONSTRATION chargé : ${n} conteneurs fictifs en stockage (ne représente pas le mapping réel de la maquette).`,
    });
    let total = n;
    if (v.plan.postes.length >= 1) {
      const a = await arriveeCamion(c, { camion_code: 'DEMO-CAM-1', conteneur_code: 'DEMO-T01', poste_code: v.plan.postes[0].code, demo: true }, 'SYSTEME');
      if (a.accepte) total++;
    }
    if (v.plan.postes.length >= 3)
      await arriveeCamion(c, { camion_code: 'DEMO-CAM-2', conteneur_code: null, poste_code: v.plan.postes[2].code, demo: true }, 'SYSTEME');
    return { conteneurs: total };
  });
}
