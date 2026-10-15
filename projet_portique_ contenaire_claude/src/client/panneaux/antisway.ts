import { simulateSway, SWAY_DEFAULTS, validateSway } from '../../shared/antisway.ts';
import type { SwayParameters, SwayResult, SwaySample } from '../../shared/antisway.ts';

const STORAGE = 'portique-antisway-v1';
const ORANGE = '#c46a18', TEAL = '#008b82';
const format = (v: number, digits = 2) => v.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
type Field = { key: keyof SwayParameters; label: string; min: number; max: number; step: number; scale?: number };
const fields: Field[] = [
  { key: 'cableM', label: 'Longueur effective estimée des câbles (mm)', min: 50, max: 2000, step: 10, scale: 1000 },
  { key: 'distanceXM', label: 'Déplacement X (mm)', min: -1500, max: 1500, step: 10, scale: 1000 },
  { key: 'distanceYM', label: 'Déplacement Y (mm)', min: -1500, max: 1500, step: 10, scale: 1000 },
  { key: 'speedMS', label: 'Vitesse maximale par axe (mm/s)', min: 20, max: 500, step: 5, scale: 1000 },
  { key: 'accelerationMS2', label: 'Accélération maximale par axe (mm/s²)', min: 10, max: 1000, step: 10, scale: 1000 },
  { key: 'massKg', label: 'Masse charge + préhenseur (kg, indicative)', min: 0.01, max: 10, step: 0.01 },
];
const advanced: Field[] = [
  { key: 'damping', label: 'Amortissement ζ (0 = aucun)', min: 0, max: 0.2, step: 0.005 },
  { key: 'cableErrorPct', label: 'Erreur simulée sur la longueur réelle (%)', min: -30, max: 30, step: 1 },
  { key: 'initialAngleDeg', label: 'Balancement initial suivant X (°)', min: -10, max: 10, step: 0.5 },
];

/** Persistent local laboratory, deliberately disconnected from mission/motor commands. */
export function rendreAntisway(root: HTMLElement): void {
  if (root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  let parameters = { ...SWAY_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
    if (saved) { const next = { ...parameters, ...saved }; validateSway(next); parameters = next; }
  } catch { /* Missing or invalid browser settings use documented defaults. */ }
  const input = (f: Field) => `<label>${f.label}<input name="${f.key}" type="number" required min="${f.min}" max="${f.max}" step="${f.step}" value="${Number((parameters[f.key] * (f.scale ?? 1)).toFixed(8))}"></label>`;
  root.innerHTML = `<div class="sway-heading"><div><span class="badge-mode sim">ÉTUDE EN SIMULATION</span><h2>Anti-ballant : comparer et comprendre</h2></div><p>Un déplacement horizontal à hauteur fixe. Orange : commande initiale. Vert : commande corrigée ZVD.</p></div>
    <form id="sway-form" class="carte"><div class="sway-fields">${fields.map(input).join('')}</div>
      <p class="note">Longueur effective : du point de suspension au centre de gravité de l’ensemble suspendu. La disposition réelle des câbles et les mesures sur maquette serviront à identifier ce mode de balancement.</p>
      <details><summary>Tester les incertitudes et une oscillation initiale</summary><div class="sway-fields">${advanced.map(input).join('')}</div></details>
      <div class="boutons"><button type="submit">Comparer les mouvements</button><button type="button" id="sway-defaults" class="secondaire">Réglages d’exemple</button></div>
      <p id="sway-status" role="status"></p>
    </form>
    <div id="sway-results" hidden>
      <div class="sway-kpis" id="sway-kpis"></div>
      <div class="carte"><h3>Rejouer le déplacement</h3><div class="boutons"><button id="sway-play">Lire la comparaison</button><button id="sway-replay" class="secondaire">Revenir au début</button><label>Lecture <select id="sway-speed"><option value="0.5">×0,5</option><option value="1" selected>×1</option><option value="2">×2</option></select></label><output id="sway-time"></output></div>
        <label for="sway-seek">Instant de la simulation</label><input id="sway-seek" type="range" min="0" max="1" step="0.01" value="0">
        <svg id="sway-animation" viewBox="0 0 920 450" role="img" aria-label="Comparaison des câbles et des charges, vus suivant X et Y"></svg>
        <p class="note">Vues schématiques X et Y du même ensemble suspendu : chaque trait représente son mode pendulaire équivalent. Les deux vues ne représentent pas deux câbles physiques. Les dimensions sont réduites à une échelle commune.</p>
      </div>
      <div class="carte"><h3>Mesurer la différence</h3><div class="sway-table" id="sway-table"></div><p class="note" id="sway-window"></p></div>
      <div class="sway-charts" id="sway-charts"></div>
      <details class="carte"><summary>Comment fonctionne la correction ?</summary><div id="sway-method"></div></details>
      <div class="carte"><h3>Conserver cette étude</h3><div class="boutons"><button id="sway-json" class="secondaire">Exporter l’étude JSON</button><button id="sway-csv" class="secondaire">Exporter les courbes CSV</button></div><p class="note">Les réglages restent mémorisés dans ce navigateur. Les exports décrivent des résultats simulés.</p></div>
    </div>
    <div class="carte sway-limit"><h3>Hypothèses à vérifier sur la maquette</h3><p>Modèle pendulaire équivalent à longueur constante, avec deux plans X/Y approximativement découplés et un mouvement rectiligne coordonné. Les rotations du préhenseur, les modes propres liés aux câbles multiples et la souplesse de la structure ne sont pas modélisés.</p><p>La masse est enregistrée à titre indicatif : elle n’intervient pas dans ce modèle pendulaire entraîné par une accélération imposée. Les limites des moteurs et leurs efforts devront être étudiés séparément.</p><p>Ce laboratoire prépare le choix de la commande. L’application des consignes aux missions et à Arduino demandera l’identification mécanique, la vérification du trajet corrigé et des essais réels.</p></div>`;
  const q = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const form = q<HTMLFormElement>('sway-form');
  let result: SwayResult | null = null, instant = 0, playing = false, request = 0, lastFrame = 0, dirty = false;
  function pause() { playing = false; cancelAnimationFrame(request); q('sway-play').textContent = 'Lire la comparaison'; }
  function sample(samples: SwaySample[]) { return samples[Math.min(samples.length - 1, Math.round(instant / result!.step))]; }
  function paint() {
    if (!result) return;
    const r = result, states = [sample(r.baseline.samples), sample(r.shaped.samples)];
    const stacked = root.clientWidth < 620;
    q('sway-animation').setAttribute('viewBox', stacked ? '0 0 460 900' : '0 0 920 450');
    const L = r.actualCableM;
    const scale = Math.min(350 / (Math.max(Math.abs(r.parameters.distanceXM), Math.abs(r.parameters.distanceYM)) + 2 * L * 0.35 + 0.15), 120 / L);
    let svg = `<title>Simulation du préhenseur et de la charge, avec et sans anti-ballant</title>`;
    for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
      const state = states[col], axis = row === 0 ? 'X' : 'Y', distance = row === 0 ? r.parameters.distanceXM : r.parameters.distanceYM;
      const position = row === 0 ? state.x : state.y, angle = row === 0 ? state.thetaX : state.thetaY;
      const left = 18 + (stacked ? 0 : col * 460), top = 20 + (stacked ? row * 2 + col : row) * 220;
      const origin = left + 55 + Math.max(0, -distance) * scale + L * 0.35 * scale;
      const x = origin + position * scale, y = top + 52, loadX = x + L * Math.sin(angle) * scale, loadY = y + L * Math.cos(angle) * scale;
      const color = col === 0 ? ORANGE : TEAL;
      svg += `<g><text x="${left}" y="${top}" class="sway-svg-label">${col === 0 ? 'Sans correction' : 'Avec ZVD'} · axe ${axis}</text>
        <line x1="${left + 8}" x2="${left + 425}" y1="${y - 9}" y2="${y - 9}" class="sway-rail"/>
        <line x1="${origin + distance * scale}" x2="${origin + distance * scale}" y1="${y}" y2="${top + 181}" class="sway-target"/>
        <rect x="${x - 17}" y="${y - 14}" width="34" height="14" rx="3" fill="${color}"/>
        <line x1="${x}" y1="${y}" x2="${loadX}" y2="${loadY}" stroke="${color}" stroke-width="3"/>
        <rect x="${loadX - 19}" y="${loadY - 7}" width="38" height="17" rx="2" fill="${color}"/>
        <text x="${left}" y="${top + 194}" class="sway-svg-small">Chariot ${format(position * 1000, 0)} mm · angle ${format(angle * 180 / Math.PI)}°</text></g>`;
    }
    q('sway-animation').innerHTML = svg;
    q('sway-time').textContent = `${format(instant)} / ${format(r.duration)} s`;
    q<HTMLInputElement>('sway-seek').value = String(instant);
  }
  function tick(now: number) {
    if (!playing || !result) return;
    if (root.hidden || document.hidden) { pause(); return; }
    instant = Math.min(result.duration, instant + Math.min(0.1, (now - lastFrame) / 1000) * Number(q<HTMLSelectElement>('sway-speed').value));
    lastFrame = now; paint();
    if (instant >= result.duration) pause(); else request = requestAnimationFrame(tick);
  }
  function plot(title: string, unit: string, read: (v: SwaySample) => number): string {
    const r = result!;
    const all = [r.baseline.samples, r.shaped.samples];
    let lo = 0, hi = 0;
    for (const values of all) for (const v of values) { lo = Math.min(lo, read(v)); hi = Math.max(hi, read(v)); }
    const margin = Math.max((hi - lo) * 0.1, 0.02); lo -= margin; hi += margin;
    const x = (time: number) => 60 + time / r.duration * 500, y = (v: number) => 190 - (v - lo) / (hi - lo) * 145;
    const lines = all.map((values, k) => {
      const stride = Math.max(1, Math.floor(values.length / 1200));
      const selected = values.filter((_, i) => i % stride === 0 || i === values.length - 1);
      return `<polyline fill="none" stroke="${k ? TEAL : ORANGE}" stroke-width="2" points="${selected.map(v => `${x(v.time).toFixed(1)},${y(read(v)).toFixed(1)}`).join(' ')}"/>`;
    }).join('');
    return `<figure class="carte"><figcaption>${title}</figcaption><svg viewBox="0 0 600 245" role="img" aria-label="${title}, orange sans correction, vert avec ZVD"><title>${title}</title>
      ${[0, 0.5, 1].map(t => { const v = lo + t * (hi - lo); return `<line x1="60" x2="560" y1="${y(v)}" y2="${y(v)}" class="sway-grid"/><text x="54" y="${y(v) + 4}" text-anchor="end" class="sway-svg-small">${format(v, 1)}</text>`; }).join('')}
      <text x="10" y="22" class="sway-svg-small">${unit}</text>
      ${[0, r.duration / 2, r.duration].map(t => `<text x="${x(t)}" y="215" text-anchor="middle" class="sway-svg-small">${format(t, 1)} s</text>`).join('')}
      ${[r.baseline, r.shaped].map((run, k) => `<line x1="${x(run.completion)}" x2="${x(run.completion)}" y1="35" y2="190" stroke="${k ? TEAL : ORANGE}" stroke-dasharray="4 4"/>`).join('')}${lines}</svg>
      <div class="sway-legend"><span class="sway-orange">Sans correction</span><span class="sway-teal">Avec ZVD</span></div><p class="note">Pointillés : fin de la commande de chaque mouvement.</p></figure>`;
  }
  function calculate() {
    pause();
    try {
      if (!form.reportValidity()) return;
      const next = { ...SWAY_DEFAULTS };
      for (const f of [...fields, ...advanced]) next[f.key] = Number((form.elements.namedItem(f.key) as HTMLInputElement).value) / (f.scale ?? 1);
      result = simulateSway(next); parameters = next; dirty = false; instant = 0;
      try { localStorage.setItem(STORAGE, JSON.stringify(parameters)); } catch { /* Private browsing may disable local persistence. */ }
      const r = result, reduction = r.residualReductionPct;
      q('sway-kpis').innerHTML = [
        ['Période du filtre', `${format(r.period)} s`, `Longueur réelle simulée : ${format(r.actualCableM * 1000, 0)} mm`],
        ['Oscillation résiduelle avec ZVD', `${r.shaped.residualAngleDeg > 0 && r.shaped.residualAngleDeg < 0.001 ? '< 0,001' : format(r.shaped.residualAngleDeg, 3)}°`, `${format(r.shaped.residualOffsetMm)} mm de déport maximal`],
        ['Réduction résiduelle simulée', reduction === null ? 'Non définie' : reduction >= 99.99 ? '≥ 99,99 %' : `${format(reduction, 1)} %`, reduction === null ? 'Référence sans oscillation mesurable' : reduction < 0 ? 'Le cas corrigé oscille davantage : revoir les hypothèses.' : 'Comparée au mouvement sans correction'],
      ].map(([a, b, c]) => `<div class="carte"><span>${a}</span><strong>${b}</strong><small>${c}</small></div>`).join('');
      const row = (label: string, base: number, shaped: number, unit: string) => `<tr><th scope="row">${label}</th><td>${format(base, 3)} ${unit}</td><td>${format(shaped, 3)} ${unit}</td></tr>`;
      q('sway-table').innerHTML = `<table><thead><tr><th>Mesure</th><th>Sans correction</th><th>Avec ZVD</th></tr></thead><tbody>${row('Durée de commande', r.baseline.completion, r.shaped.completion, 's')}${row('Angle maximal pendant toute l’étude', r.baseline.peakAngleDeg, r.shaped.peakAngleDeg, '°')}${row('Angle résiduel maximal après l’arrêt', r.baseline.residualAngleDeg, r.shaped.residualAngleDeg, '°')}${row('Déport résiduel maximal de la charge', r.baseline.residualOffsetMm, r.shaped.residualOffsetMm, 'mm')}</tbody></table>`;
      q('sway-window').textContent = 'Chaque oscillation résiduelle est mesurée pendant deux périodes réelles simulées après la fin de sa propre commande. Le filtre prolonge la commande de ' + format(r.period) + ' s. L’angle affiché est la norme des angles X/Y.';
      q('sway-charts').innerHTML = plot('Balancement suivant X', '°', s => s.thetaX * 180 / Math.PI) + plot('Balancement suivant Y', '°', s => s.thetaY * 180 / Math.PI) + plot('Accélération du chariot suivant X', 'mm/s²', s => s.ax * 1000) + plot('Accélération du chariot suivant Y', 'mm/s²', s => s.ay * 1000);
      q('sway-method').innerHTML = `<p>Le filtre additionne trois copies décalées et pondérées du même profil de mouvement. La somme des poids vaut 1 : la destination finale du chariot est conservée.</p>
        <p class="sway-equation">a<sub>ZVD</sub>(t) = Σ A<sub>i</sub> a(t − t<sub>i</sub>)</p><p>${r.shaper.map((i, n) => `A${n + 1} = ${format(i.weight, 4)} à t = ${format(i.time, 3)} s`).join(' ; ')}.</p>
        <p>Modèle simulé sur chaque axe : θ̈ + 2ζωₙθ̇ + (g/L) sin θ = −(a/L) cos θ ; ωₙ = √(g/L).</p>
        <p>Le ZVD est conçu avec la linéarisation aux petits angles. Une erreur sur la longueur, un angle initial ou des modes supplémentaires peuvent laisser un balancement résiduel. Une modification de hauteur pendant le déplacement demande un autre traitement.</p>
        <p><a href="https://www.mdpi.com/1424-8220/18/6/1817" target="_blank" rel="noopener">Référence : input shaping appliqué aux grues</a></p>`;
      const large = Math.max(r.baseline.peakAngleDeg, r.shaped.peakAngleDeg) > 10;
      q('sway-status').textContent = large ? 'Calcul terminé. Angle supérieur à 10° : l’hypothèse des deux plans découplés devient moins fiable ; réduire l’accélération.' : 'Comparaison calculée. Valeurs simulées, à confronter aux mesures de la maquette.';
      q('sway-status').className = large ? 'sway-warning' : 'note';
      q('sway-results').hidden = false;
      for (const id of ['sway-play', 'sway-replay', 'sway-json', 'sway-csv', 'sway-seek']) (q(id) as HTMLButtonElement).disabled = false;
      q<HTMLInputElement>('sway-seek').max = String(r.duration); paint();
    } catch (e) { q('sway-status').textContent = (e as Error).message; q('sway-status').className = 'sway-warning'; }
  }
  form.addEventListener('submit', e => { e.preventDefault(); calculate(); });
  form.addEventListener('input', () => {
    dirty = true; pause(); q('sway-status').textContent = 'Paramètres modifiés : cliquez sur « Comparer les mouvements » pour recalculer.';
    for (const id of ['sway-play', 'sway-replay', 'sway-json', 'sway-csv', 'sway-seek']) (q(id) as HTMLButtonElement).disabled = true;
  });
  q('sway-defaults').addEventListener('click', () => {
    for (const f of [...fields, ...advanced]) (form.elements.namedItem(f.key) as HTMLInputElement).value = String(SWAY_DEFAULTS[f.key] * (f.scale ?? 1));
    calculate();
  });
  q('sway-play').addEventListener('click', () => {
    if (dirty || !result) return;
    if (playing) return pause();
    if (instant >= result.duration) instant = 0;
    playing = true; lastFrame = performance.now(); q('sway-play').textContent = 'Pause'; request = requestAnimationFrame(tick);
  });
  q('sway-replay').addEventListener('click', () => { pause(); instant = 0; paint(); });
  q('sway-seek').addEventListener('input', () => { pause(); instant = Number(q<HTMLInputElement>('sway-seek').value); paint(); });
  function download(kind: 'json' | 'csv') {
    if (!result || dirty) return;
    const r = result;
    const rows = ['time_s,mode,cart_x_m,cart_y_m,velocity_x_m_s,velocity_y_m_s,acceleration_x_m_s2,acceleration_y_m_s2,theta_x_rad,theta_y_rad,load_x_m,load_y_m,offset_mm'];
    if (kind === 'csv') for (const [name, run] of [['baseline', r.baseline], ['zvd', r.shaped]] as const) for (const s of run.samples) rows.push([s.time, name, s.x, s.y, s.vx, s.vy, s.ax, s.ay, s.thetaX, s.thetaY, s.loadX, s.loadY, s.offsetMm].join(','));
    const content = kind === 'csv' ? rows.join('\n') : JSON.stringify({ version: 1, model: 'equivalent-pendulum-xy-constant-length', simulationOnly: true, generatedAt: new Date().toISOString(), ...r }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `portique-anti-ballant.${kind}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  q('sway-json').addEventListener('click', () => download('json'));
  q('sway-csv').addEventListener('click', () => download('csv'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  window.addEventListener('resize', paint);
  calculate();
}
