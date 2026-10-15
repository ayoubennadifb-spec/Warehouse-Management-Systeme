import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { nouvelleBase, tx, cont, pile, positionDeHauteur } from './aide.ts';
import { une } from '../src/server/db.ts';
import { ErreurMetier } from '../src/server/erreurs.ts';
import { parametresParDefaut } from '../src/server/config.ts';
import { activerVersion, analyserActivation, creerVersion } from '../src/server/domaine/plans.ts';
import { departCamion } from '../src/server/domaine/camions.ts';
import { declarerPosition } from '../src/server/domaine/conteneurs.ts';

let pool: pg.Pool;
before(async () => {
  pool = await nouvelleBase();
  // les changements de plan exigent qu'aucun camion ne soit présent
  const v = await pool.query(`SELECT id FROM visite_camion WHERE statut = 'PRESENTE'`);
  for (const r of v.rows) {
    const plateau = await une(pool, `SELECT e.id FROM emplacement e JOIN visite_camion v ON v.camion_id = e.camion_id WHERE v.id = $1`, [r.id]);
    await tx(pool, (c) => departCamion(c, r.id, 'OPERATEUR'));
    void plateau;
  }
});
after(async () => {
  await pool.end();
});

async function code(p: Promise<unknown>): Promise<ErreurMetier> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ErreurMetier, (e as Error).message);
    return e;
  }
  assert.fail('refus attendu');
}

test('paramètres invalides refusés avec explication, rien n’est écrit', async () => {
  const p = parametresParDefaut();
  p.grille.nb_positions_x = 9;
  const avant = (await une(pool, 'SELECT count(*)::int AS n FROM version_plan')).n;
  const e = await code(tx(pool, (c) => creerVersion(c, p, 'OPERATEUR')));
  assert.equal(e.code, 'PLAN_INVALIDE');
  assert.match(e.message, /ne tient pas suivant X/);
  assert.equal((await une(pool, 'SELECT count(*)::int AS n FROM version_plan')).n, avant);
});

test('même géométrie, autre capacité : conteneurs conservés sans déplacement fictif', async () => {
  const p = parametresParDefaut();
  p.capacite.nb_conteneurs_max = 55;
  p.libelle = 'Capacité 55';
  const pos2 = await positionDeHauteur(pool, 2);
  const avant = await pile(pool, pos2);
  const coordAvant = (await cont(pool, avant[1])) as any;
  const v = await tx(pool, (c) => creerVersion(c, p, 'OPERATEUR'));
  const a = await tx(pool, (c) => activerVersion(c, v.id, { forcer: false, source: 'OPERATEUR' }));
  assert.equal(a.impactes.length, 0);
  assert.ok(a.conserves.length > 30);
  assert.deepEqual(await pile(pool, pos2), avant);
  const apres = (await cont(pool, avant[1])) as any;
  assert.deepEqual([apres.x_mm, apres.y_mm, apres.z_mm], [coordAvant.x_mm, coordAvant.y_mm, coordAvant.z_mm]);
  assert.notEqual(apres.emplacement_id, coordAvant.emplacement_id, 'rattaché à l’emplacement du nouveau plan');
  // l'ancienne version est archivée et immuable
  const anc = await une(pool, `SELECT id, statut FROM version_plan WHERE numero = 1`);
  assert.equal(anc.statut, 'ARCHIVEE');
  const e = await code(tx(pool, (c) => c.query(`UPDATE version_plan SET nb_positions_x = 5 WHERE id = $1`, [anc.id])));
  assert.equal(e.code, 'PLAN_IMMUABLE');
  const e2 = await code(tx(pool, (c) => c.query(`UPDATE position_sol SET centre_x_mm = 1 WHERE version_plan_id = $1`, [anc.id])));
  assert.equal(e2.code, 'PLAN_IMMUABLE');
});

test('espacement modifié : activation refusée, puis forcée → positions incertaines', async () => {
  const p = parametresParDefaut();
  p.grille.espacement_x_mm = 10;
  p.libelle = 'Espacement X 10 mm';
  const v = await tx(pool, (c) => creerVersion(c, p, 'OPERATEUR'));
  const an = await analyserActivation(pool, v.id);
  assert.ok(an.impactes.length > 0);
  const e = await code(tx(pool, (c) => activerVersion(c, v.id, { forcer: false, source: 'OPERATEUR' })));
  assert.equal(e.code, 'IMPACT_PLAN');
  assert.equal((await une(pool, `SELECT statut FROM version_plan WHERE id = $1`, [v.id])).statut, 'BROUILLON');
  const r = await tx(pool, (c) => activerVersion(c, v.id, { forcer: true, source: 'OPERATEUR' }));
  const inc = await une(pool, `SELECT count(*)::int AS n FROM conteneur WHERE etat = 'INCERTAINE'`);
  assert.equal(inc.n, r.impactes.length);
  // les dernières coordonnées connues sont conservées (aucune position inventée)
  const c1 = await une(pool, `SELECT * FROM conteneur WHERE etat = 'INCERTAINE' ORDER BY code LIMIT 1`);
  assert.ok(c1.derniere_x_mm !== null);
  // déclaration de la position réelle dans le nouveau plan
  const e1 = await une(
    pool,
    `SELECT e.id FROM emplacement e JOIN version_plan v ON v.id = e.version_plan_id AND v.statut = 'ACTIVE'
      WHERE e.niveau = 1 AND NOT EXISTS (SELECT 1 FROM conteneur x WHERE x.emplacement_id = e.id) ORDER BY e.id LIMIT 1`,
  );
  await tx(pool, (c) => declarerPosition(c, c1.id, { emplacement_id: e1.id }));
  assert.equal((await une(pool, `SELECT etat FROM conteneur WHERE id = $1`, [c1.id])).etat, 'EN_PLACE');
});

test('grille 6 × 5 × 4 : nombres recalculés en base', async () => {
  const p = parametresParDefaut();
  p.grille.nb_positions_x = 6;
  p.grille.nb_positions_y = 5;
  p.grille.nb_niveaux_max = 4;
  const v = await tx(pool, (c) => creerVersion(c, p, 'OPERATEUR'));
  const r = await une(pool, `SELECT * FROM v_capacite_plan WHERE version_plan_id = $1`, [v.id]);
  assert.equal(Number(r.nb_positions_sol), 30);
  assert.equal(Number(r.nb_emplacements), 120);
});
