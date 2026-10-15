import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculerPlan, type ParametresMaquette } from '../src/shared/geometrie.ts';

const defaut = (): ParametresMaquette =>
  JSON.parse(readFileSync(new URL('../config/maquette.defaut.json', import.meta.url), 'utf8'));

test('les deux zones partagent exactement l’espace 1000 × 500 mm', () => {
  const plan = calculerPlan(defaut());
  assert.equal(plan.ok, true, plan.erreurs.join(' | '));
  const s = plan.zones.find((z) => z.code === 'STOCKAGE')!;
  const t = plan.zones.find((z) => z.code === 'TRANSPORT')!;
  assert.deepEqual([s.x_min, s.x_max, s.y_min, s.y_max], [0, 800, 0, 500]);
  assert.deepEqual([t.x_min, t.x_max, t.y_min, t.y_max], [800, 1000, 0, 500]);
  const aire = (z: typeof s) => (z.x_max - z.x_min) * (z.y_max - z.y_min);
  assert.equal(aire(s) + aire(t), 1000 * 500);
  assert.equal(s.x_max, t.x_min, 'zones contiguës, sans recouvrement');
});

test('répartition uniforme proposée : 12,5 mm suivant X et 18,75 mm suivant Y', () => {
  const plan = calculerPlan(defaut());
  assert.equal(plan.repartition_x!.espacement, 12.5);
  assert.equal(plan.repartition_x!.marge_debut, 12.5);
  assert.equal(plan.repartition_x!.marge_fin, 12.5);
  assert.equal(plan.repartition_y!.espacement, 18.75);
  assert.equal(plan.repartition_y!.marge_fin, 18.75);
});

test('49 positions au sol, 147 emplacements, toutes dans la zone de stockage', () => {
  const plan = calculerPlan(defaut());
  assert.equal(plan.nb_positions_sol, 49);
  assert.equal(plan.nb_emplacements, 147);
  assert.equal(plan.hauteur_pile_max, 150);
  for (const p of plan.positions) {
    assert.ok(p.centre_x - 50 >= 0 && p.centre_x + 50 <= 800, `${p.code} hors stockage en X`);
    assert.ok(p.centre_y - 25 >= 0 && p.centre_y + 25 <= 500, `${p.code} hors stockage en Y`);
  }
  const a1 = plan.positions.find((p) => p.code === 'A1')!;
  assert.deepEqual([a1.centre_x, a1.centre_y], [62.5, 43.75]);
  const g7 = plan.positions.find((p) => p.code === 'G7')!;
  assert.deepEqual([g7.centre_x, g7.centre_y], [737.5, 456.25]);
  assert.deepEqual(plan.niveaux.map((n) => n.z_base), [0, 50, 100]);
});

test('les camions (150 × 50 mm) tiennent dans la zone transport sans se chevaucher', () => {
  const plan = calculerPlan(defaut());
  assert.equal(plan.camion.longueur_totale, 150);
  assert.equal(plan.postes.length, 4);
  for (const p of plan.postes) {
    assert.ok(p.centre_x - 75 >= 800 && p.centre_x + 75 <= 1000);
    assert.ok(p.centre_y - 25 >= 0 && p.centre_y + 25 <= 500);
    // plateau côté stockage, cabine côté X max
    assert.equal(p.plateau.x, 875);
    assert.equal(p.cabine.x, 950);
  }
});

test('paramètres modifiés : les nombres sont recalculés', () => {
  const p = defaut();
  p.grille.nb_positions_x = 6;
  p.grille.nb_positions_y = 5;
  p.grille.nb_niveaux_max = 4;
  const plan = calculerPlan(p);
  assert.equal(plan.ok, true);
  assert.equal(plan.nb_positions_sol, 30);
  assert.equal(plan.nb_emplacements, 120);
});

test('grille trop grande refusée avec explication', () => {
  const p = defaut();
  p.grille.nb_positions_x = 8;
  p.grille.espacement_x_mm = 20;
  const plan = calculerPlan(p);
  assert.equal(plan.ok, false);
  assert.match(plan.erreurs.join(' '), /ne tient pas suivant X/);
});

test('trop de postes camion refusés', () => {
  const p = defaut();
  p.postes.nb_postes = 11;
  const plan = calculerPlan(p);
  assert.equal(plan.ok, false);
  assert.match(plan.erreurs.join(' '), /ne tiennent pas/);
});

test('postes placés manuellement qui se chevauchent refusés', () => {
  const p = defaut();
  p.postes.nb_postes = 2;
  p.postes.positions = [
    { code: 'P1', centre_x_mm: 900, centre_y_mm: 100 },
    { code: 'P2', centre_x_mm: 900, centre_y_mm: 130 },
  ];
  const plan = calculerPlan(p);
  assert.equal(plan.ok, false);
  assert.match(plan.erreurs.join(' '), /se chevauchent/);
});

test('zone transport côté X min (convention modifiable)', () => {
  const p = defaut();
  p.zones.transport_cote = 'X_MIN';
  p.postes.cote_cabine = 'X_MIN';
  const plan = calculerPlan(p);
  assert.equal(plan.ok, true);
  assert.equal(plan.zones.find((z) => z.code === 'TRANSPORT')!.x_max, 200);
  assert.equal(plan.positions[0].centre_x, 262.5);
  assert.equal(plan.postes[0].plateau.x, 125);
});
