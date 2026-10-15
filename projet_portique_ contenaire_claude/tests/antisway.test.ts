import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMove, GRAVITY, simulateSway, SWAY_DEFAULTS, zvd } from '../src/shared/antisway.ts';

test('ZVD sans amortissement : poids 1/4, 1/2, 1/4 séparés par une demi-période', () => {
  const impulses = zvd(0.5, 0), period = 2 * Math.PI * Math.sqrt(0.5 / GRAVITY);
  assert.deepEqual(impulses.map(i => i.weight), [0.25, 0.5, 0.25]);
  assert.ok(Math.abs(impulses[1].time - period / 2) < 1e-14);
  assert.ok(Math.abs(impulses[2].time - period) < 1e-14);
  for (const damping of [0, 0.01, 0.1, 0.2]) {
    const values = zvd(0.7, damping);
    assert.ok(values.every(i => i.weight > 0));
    assert.ok(Math.abs(values.reduce((a, i) => a + i.weight, 0) - 1) < 1e-14);
    // Zero residual modal response and zero derivative at the design pole.
    const wn = Math.sqrt(GRAVITY / 0.7), wd = wn * Math.sqrt(1 - damping ** 2);
    const re = values.reduce((a, i) => a + i.weight * Math.exp(damping * wn * i.time) * Math.cos(wd * i.time), 0);
    const im = values.reduce((a, i) => a + i.weight * Math.exp(damping * wn * i.time) * Math.sin(wd * i.time), 0);
    assert.ok(Math.hypot(re, im) < 1e-13);
    const dre = values.reduce((a, i) => a + i.time * i.weight * Math.exp(damping * wn * i.time) * Math.cos(wd * i.time), 0);
    const dim = values.reduce((a, i) => a + i.time * i.weight * Math.exp(damping * wn * i.time) * Math.sin(wd * i.time), 0);
    assert.ok(Math.hypot(dre, dim) < 1e-13);
  }
});

test('profils triangulaire et trapézoïdal : fin exacte, limites et déplacement XY signé', () => {
  for (const d of [0.001, 0.5]) {
    const p = { ...SWAY_DEFAULTS, distanceXM: -d, distanceYM: d / 2 };
    const move = createMove(p);
    for (const impulses of [[{ time: 0, weight: 1 }], zvd(p.cableM, p.damping)]) {
      const end = move.completion + impulses.at(-1)!.time;
      for (let i = 0; i <= 1000; i++) {
        const s = move.at(end * i / 1000, impulses);
        assert.ok(s.x <= 1e-12 && s.x >= -d - 1e-12);
        assert.ok(Math.abs(s.vx) <= p.speedMS + 1e-12);
        assert.ok(Math.abs(s.ax) <= p.accelerationMS2 + 1e-12);
        assert.ok(Math.abs(s.y + s.x / 2) < 1e-12);
      }
      const last = move.at(end + 1e-9, impulses);
      assert.ok(Math.abs(last.x + d) < 1e-12);
      assert.ok(Math.abs(last.y - d / 2) < 1e-12);
      assert.ok(Math.abs(last.vx) < 1e-14); assert.ok(Math.abs(last.ax) < 1e-14);
    }
  }
});

test('sans déplacement ni angle initial : aucune oscillation et réduction non définie', () => {
  const r = simulateSway({ ...SWAY_DEFAULTS, distanceXM: 0, distanceYM: 0 });
  assert.equal(r.baseline.peakAngleDeg, 0);
  assert.equal(r.shaped.residualOffsetMm, 0);
  assert.equal(r.residualReductionPct, null);
});

test('pendule libre : accord avec la solution analytique aux très petits angles', () => {
  const p = { ...SWAY_DEFAULTS, distanceXM: 0, distanceYM: 0, initialAngleDeg: 0.1 };
  const r = simulateSway(p);
  const wn = Math.sqrt(GRAVITY / p.cableM), wd = wn * Math.sqrt(1 - p.damping ** 2), theta0 = 0.1 * Math.PI / 180;
  let error = 0;
  for (const s of r.baseline.samples) {
    const expected = theta0 * Math.exp(-p.damping * wn * s.time) * (Math.cos(wd * s.time) + p.damping * wn / wd * Math.sin(wd * s.time));
    error = Math.max(error, Math.abs(s.thetaX - expected));
  }
  assert.ok(error < 1e-8, `erreur angulaire ${error}`);
});

test('réduction du résiduel nominal, destination conservée, erreur de longueur étudiée', () => {
  const nominal = simulateSway(SWAY_DEFAULTS);
  assert.ok(nominal.baseline.residualAngleDeg > 1);
  assert.ok(nominal.shaped.residualAngleDeg < nominal.baseline.residualAngleDeg / 1000);
  assert.ok(Math.abs(nominal.shaped.samples.at(-1)!.x - SWAY_DEFAULTS.distanceXM) < 1e-12);
  assert.ok(Math.abs(nominal.shaped.samples.at(-1)!.y - SWAY_DEFAULTS.distanceYM) < 1e-12);
  assert.ok(Math.abs(nominal.shaped.completion - nominal.baseline.completion - nominal.period) < 1e-12);
  const mismatch = simulateSway({ ...SWAY_DEFAULTS, cableErrorPct: 25 });
  assert.ok(mismatch.shaped.residualAngleDeg > 10 * nominal.shaped.residualAngleDeg);
});

test('convergence numérique et invariance à la masse dans le modèle imposé', () => {
  const coarse = simulateSway({ ...SWAY_DEFAULTS, initialAngleDeg: 2, cableErrorPct: -20 }, 0.005);
  const fine = simulateSway({ ...SWAY_DEFAULTS, initialAngleDeg: 2, cableErrorPct: -20 }, 0.0025);
  assert.ok(Math.abs(coarse.shaped.samples.at(-1)!.thetaX - fine.shaped.samples.at(-1)!.thetaX) < 1e-7);
  assert.ok(Math.abs(coarse.shaped.residualAngleDeg - fine.shaped.residualAngleDeg) < 0.005);
  const otherMass = simulateSway({ ...SWAY_DEFAULTS, massKg: 2 });
  const normal = simulateSway(SWAY_DEFAULTS);
  assert.deepEqual(normal.shaped.samples, otherMass.shaped.samples);
});

test('les valeurs physiques invalides sont refusées', () => {
  for (const p of [{ cableM: 0 }, { cableM: NaN }, { damping: 1 }, { speedMS: 0 }, { accelerationMS2: -1 }, { cableErrorPct: -100 }]) {
    assert.throws(() => simulateSway({ ...SWAY_DEFAULTS, ...p }));
  }
  assert.throws(() => simulateSway(SWAY_DEFAULTS, 0));
});
