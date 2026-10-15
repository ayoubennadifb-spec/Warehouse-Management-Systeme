/** Offline single-mode anti-sway study. SI units; no actuator or inventory writes. */
export interface SwayParameters {
  cableM: number;
  cableErrorPct: number;
  damping: number;
  massKg: number;
  distanceXM: number;
  distanceYM: number;
  speedMS: number;
  accelerationMS2: number;
  initialAngleDeg: number;
}
export const SWAY_DEFAULTS: SwayParameters = {
  cableM: 0.5, cableErrorPct: 0, damping: 0.015, massKg: 0.3,
  distanceXM: 0.5, distanceYM: 0.2, speedMS: 0.15, accelerationMS2: 0.25, initialAngleDeg: 0,
};
export const GRAVITY = 9.81;
export interface ShaperImpulse { time: number; weight: number }
export interface CartState { x: number; y: number; vx: number; vy: number; ax: number; ay: number }
export interface SwaySample extends CartState {
  time: number; thetaX: number; thetaY: number; omegaX: number; omegaY: number;
  loadX: number; loadY: number; angleDeg: number; offsetMm: number;
}
export interface SwayRun {
  completion: number; samples: SwaySample[];
  peakAngleDeg: number; residualAngleDeg: number; residualOffsetMm: number; finalPositionErrorMm: number;
}
export interface SwayResult {
  parameters: SwayParameters; period: number; actualCableM: number; shaper: ShaperImpulse[];
  step: number; duration: number; baseline: SwayRun; shaped: SwayRun; residualReductionPct: number | null;
}

export function validateSway(p: SwayParameters): void {
  const limits: [keyof SwayParameters, number, number][] = [
    ['cableM', 0.05, 2], ['cableErrorPct', -30, 30], ['damping', 0, 0.2], ['massKg', 0.01, 10],
    ['distanceXM', -1.5, 1.5], ['distanceYM', -1.5, 1.5], ['speedMS', 0.02, 0.5],
    ['accelerationMS2', 0.01, 1], ['initialAngleDeg', -10, 10],
  ];
  for (const [key, min, max] of limits) {
    if (!Number.isFinite(p[key]) || p[key] < min || p[key] > max) throw new Error(`Paramètre hors limites : ${key}.`);
  }
}

/** Damped ZVD: three nonnegative impulses of unit total gain. */
export function zvd(cableM: number, damping: number): ShaperImpulse[] {
  if (!Number.isFinite(cableM) || cableM <= 0 || !Number.isFinite(damping) || damping < 0 || damping >= 1) {
    throw new Error('Longueur positive et amortissement entre 0 et 1 requis.');
  }
  const halfPeriod = Math.PI / (Math.sqrt(GRAVITY / cableM) * Math.sqrt(1 - damping ** 2));
  const k = Math.exp(-damping * Math.PI / Math.sqrt(1 - damping ** 2));
  const scale = (1 + k) ** 2;
  return [{ time: 0, weight: 1 / scale }, { time: halfPeriod, weight: 2 * k / scale }, { time: 2 * halfPeriod, weight: k * k / scale }];
}

/** A straight coordinated XY move; each axis obeys the selected v/a limits. */
export function createMove(p: SwayParameters) {
  const distance = Math.max(Math.abs(p.distanceXM), Math.abs(p.distanceYM));
  const ramp = distance ? Math.min(p.speedMS / p.accelerationMS2, Math.sqrt(distance / p.accelerationMS2)) : 0;
  const peak = p.accelerationMS2 * ramp;
  const cruise = distance ? Math.max(0, (distance - peak * ramp) / peak) : 0;
  const completion = 2 * ramp + cruise;
  const scalar = (time: number) => {
    if (time < 0 || distance === 0) return { position: 0, velocity: 0, acceleration: 0 };
    if (time < ramp) return { position: 0.5 * p.accelerationMS2 * time ** 2, velocity: p.accelerationMS2 * time, acceleration: p.accelerationMS2 };
    if (time < ramp + cruise) return { position: 0.5 * peak * ramp + peak * (time - ramp), velocity: peak, acceleration: 0 };
    if (time < completion) {
      const remaining = completion - time;
      return { position: distance - 0.5 * p.accelerationMS2 * remaining ** 2, velocity: p.accelerationMS2 * remaining, acceleration: -p.accelerationMS2 };
    }
    return { position: distance, velocity: 0, acceleration: 0 };
  };
  const at = (time: number, impulses: ShaperImpulse[]): CartState => {
    let x = 0, v = 0, a = 0;
    for (const impulse of impulses) {
      const value = scalar(time - impulse.time);
      x += impulse.weight * value.position; v += impulse.weight * value.velocity; a += impulse.weight * value.acceleration;
    }
    const sx = distance ? p.distanceXM / distance : 0, sy = distance ? p.distanceYM / distance : 0;
    return { x: x * sx, y: x * sy, vx: v * sx, vy: v * sy, ax: a * sx, ay: a * sy };
  };
  return { at, completion, breaks: [0, ramp, ramp + cruise, completion] };
}

export function simulateSway(parameters: SwayParameters, maxStep = 0.005): SwayResult {
  const p = { ...parameters };
  validateSway(p);
  if (!Number.isFinite(maxStep) || maxStep < 0.0001 || maxStep > 0.02) throw new Error('Pas de simulation invalide.');
  const shaper = zvd(p.cableM, p.damping);
  const period = shaper[2].time;
  const actualCableM = p.cableM * (1 + p.cableErrorPct / 100);
  const actualPeriod = 2 * Math.PI * Math.sqrt(actualCableM / GRAVITY) / Math.sqrt(1 - p.damping ** 2);
  const move = createMove(p);
  const duration = move.completion + period + 2 * actualPeriod;
  const count = Math.ceil(duration / Math.min(maxStep, actualPeriod / 200));
  const step = duration / count;
  const frequency = Math.sqrt(GRAVITY / actualCableM);
  const simulate = (impulses: ShaperImpulse[]): SwayRun => {
    const completion = move.completion + impulses.at(-1)!.time;
    const breaks = [...new Set(impulses.flatMap(i => move.breaks.map(t => t + i.time)))].sort((a, b) => a - b);
    let breakIndex = 0;
    let state = [p.initialAngleDeg * Math.PI / 180, 0, 0, 0];
    const samples: SwaySample[] = [];
    let peakAngleDeg = 0, residualAngleDeg = 0, residualOffsetMm = 0;
    const advance = (time: number, h: number) => {
      // Split at every acceleration discontinuity so RK4 sees a constant forcing per substep.
      const forcing = move.at(time + h / 2, impulses);
      const derivative = (q: number[]) => [q[1],
        -(frequency ** 2) * Math.sin(q[0]) - 2 * p.damping * frequency * q[1] - forcing.ax / actualCableM * Math.cos(q[0]), q[3],
        -(frequency ** 2) * Math.sin(q[2]) - 2 * p.damping * frequency * q[3] - forcing.ay / actualCableM * Math.cos(q[2])];
      const a = derivative(state), b = derivative(state.map((v, i) => v + h * a[i] / 2));
      const c = derivative(state.map((v, i) => v + h * b[i] / 2)), d = derivative(state.map((v, i) => v + h * c[i]));
      state = state.map((v, i) => v + h * (a[i] + 2 * b[i] + 2 * c[i] + d[i]) / 6);
    };
    for (let i = 0; i <= count; i++) {
      const time = i * step;
      if (i > 0) {
        let from = (i - 1) * step;
        while (breakIndex < breaks.length && breaks[breakIndex] <= from + 1e-12) breakIndex++;
        while (breakIndex < breaks.length && breaks[breakIndex] < time - 1e-12) {
          const end = breaks[breakIndex++]; advance(from, end - from); from = end;
        }
        if (time > from) advance(from, time - from);
      }
      const cart = move.at(time, impulses);
      const angleDeg = Math.hypot(state[0], state[2]) * 180 / Math.PI;
      const dx = actualCableM * Math.sin(state[0]), dy = actualCableM * Math.sin(state[2]);
      const offsetMm = Math.hypot(dx, dy) * 1000;
      samples.push({ time, ...cart, thetaX: state[0], thetaY: state[2], omegaX: state[1], omegaY: state[3],
        loadX: cart.x + dx, loadY: cart.y + dy, angleDeg, offsetMm });
      peakAngleDeg = Math.max(peakAngleDeg, angleDeg);
      // Equal observation window: two actual periods after each run's own end of command.
      if (time >= completion && time <= completion + 2 * actualPeriod + step) {
        residualAngleDeg = Math.max(residualAngleDeg, angleDeg);
        residualOffsetMm = Math.max(residualOffsetMm, offsetMm);
      }
    }
    const last = samples.at(-1)!;
    return { samples, completion, peakAngleDeg, residualAngleDeg, residualOffsetMm,
      finalPositionErrorMm: Math.hypot(last.loadX - p.distanceXM, last.loadY - p.distanceYM) * 1000 };
  };
  const baseline = simulate([{ time: 0, weight: 1 }]), shaped = simulate(shaper);
  return { parameters: p, period, actualCableM, shaper, step, duration, baseline, shaped,
    residualReductionPct: baseline.residualAngleDeg < 1e-6 ? null : 100 * (1 - shaped.residualAngleDeg / baseline.residualAngleDeg) };
}
