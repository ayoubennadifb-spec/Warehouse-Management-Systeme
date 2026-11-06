import { brancherCalibration } from './calibration.ts';
/** Persistent controls and pixel observations, independent of inventory mutations. */
import { api } from '../api.ts';
import { esc, dateHeure } from '../util.ts';

type Settings = Record<string, number> & { roi: { x: number; y: number; width: number; height: number } };
const fields: [string, string, number, number, number][] = [
  ['min_area', 'Surface minimale du dessus (px²)', 10, 100000, 10],
  ['min_side_area', 'Surface minimale des côtés (px²)', 100, 10000, 50],
];

export function rendreVision(root: HTMLElement): void {
  if (root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  let settings: Settings | null = null;
  let videoId: string | null = null;
  let busy = false;
  let lastSession = '';
  let lastFrame = -1;
  let initialSource = true;
  root.innerHTML = `<h2>Vision — segmentation des faces</h2>
    <p class="note">Surfaces en pixels². Les numéros identifient les détections et sont temporaires.</p>
    <div class="carte vision-controls">
    <p><strong>Détecteur : YOLO11s Segmentation — faces entraînées</strong></p><p class="note">Vert : dessus · bleu clair : côté long · orange : côté court. Le filtre géométrique retire les masques trop irréguliers. La luminosité est automatiquement renforcée sur les images sombres.</p><label>Source <select id="vision-source"><option value="image">Image importée</option><option value="video">Vidéo importée</option><option value="camera" selected>Caméra / Android via DroidCam</option></select></label>
      <div id="vision-camera" hidden><button id="vision-list-cameras" class="secondaire">Rechercher les caméras</button><label>Caméras disponibles <select id="vision-device"><option value="">Utiliser l’indice manuel</option></select></label><label>Indice caméra <input id="vision-index" type="number" min="0" max="20" value="2"></label><p class="note">Gardez DroidCam connecté sur Android et Windows. Choisissez « DroidCam Video ». Fermez les autres applications qui utilisent cette caméra.</p></div>
      <div id="vision-video" hidden><label>Image ou vidéo (64 Mo max.) <input id="vision-file" type="file" accept=".png,.jpg,.jpeg,.webp,.bmp,.mp4,.avi,.mov,.mkv,.webm"></label><label><input id="vision-loop" type="checkbox" checked> Rejouer la vidéo en boucle</label><p id="vision-filename" class="note"></p></div>
      <p class="note">Une même caisse peut produire plusieurs détections si son dessus et ses côtés sont visibles. Les numéros suivent des faces détectées, pas l’inventaire.</p>
      <p id="vision-message" role="status"></p><p id="vision-status" aria-live="polite">Aucune source active.</p>
    </div>
    <div id="vision-images" hidden>${[['original', 'Image originale'], ['mask', 'Masque / contours'], ['annotated', 'Objets et faces détectés']].map(([kind, title]) => `<figure><figcaption>${title}</figcaption><img data-vision-image="${kind}" alt="${title}" loading="lazy"></figure>`).join('')}</div>
    <details class="carte"><summary>Régler la détection et la zone d’analyse</summary>
      <p class="note">Les faces latérales sont souvent plus petites que le dessus : leur seuil est réglé séparément. Une forme doit aussi être assez compacte et convexe pour être retenue. La zone d’analyse est exprimée en pourcentage de l’image.</p>
      <div id="vision-settings">Chargement des réglages…</div>
      <div class="boutons"><button id="vision-save">Appliquer et sauvegarder</button><button id="vision-reload" class="secondaire">Recharger</button><button id="vision-download" class="secondaire">Exporter les réglages</button></div>
      <label>Importer des réglages JSON <input id="vision-import" type="file" accept=".json,application/json"></label>
    </details>
    <div class="carte"><h3>Surface des faces détectées</h3><div id="vision-measures">Aucune surface mesurée.</div></div>
    <div class="carte"><h3>Capturer les résultats</h3><button id="vision-export" disabled>Enregistrer les images et les mesures</button><div id="vision-downloads"></div><p class="note">Chaque export rassemble une même image : original, masque, annotation, mesures JSON et CSV. Aucun inventaire modifié.</p></div>
    <p class="note">Seules les faces visibles sont détectées. Deux faces de même couleur qui se touchent peuvent fusionner. Un contour masqué ou coupé est rejeté.</p>`;
  brancherCalibration(root);
  const q = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>('#'+id)!;
  const message = (text: string, error = false) => { q('vision-message').textContent = text; q('vision-message').className = error ? 'vision-error' : 'note'; };
  const control = async (f: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try { await f(); } catch (e) { message((e as Error).message, true); }
    finally { busy = false; }
  };
  const showSettings = (s: Settings) => {
    settings = s;
    q('vision-settings').innerHTML = fields.map(([key, label, min, max, step]) => `<label class="vision-slider">${label} <output data-for="${key}">${s[key]}</output><input data-setting="${key}" type="range" min="${min}" max="${Math.max(max, s[key])}" step="${step}" value="${s[key]}"></label>`).join('')+
      `<label>Surface maximale d’une face (px²)<input data-setting="max_area" type="number" min="10" max="10000000" value="${s.max_area}"></label>`+
      Object.entries(s.roi).map(([key, value]) => `<label>Zone ${({ x: 'gauche', y: 'haut', width: 'largeur', height: 'hauteur' } as Record<string, string>)[key]} (%)<input data-roi="${key}" type="number" min="0" max="100" step="0.1" value="${value}"></label>`).join('');
  };
  const readSettings = () => {
    if (!settings) throw new Error('Les réglages ne sont pas encore disponibles.');
    const next = JSON.parse(JSON.stringify(settings));
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach(el => { next[el.dataset.setting!] = Number(el.value); });
    root.querySelectorAll<HTMLInputElement>('[data-roi]').forEach(el => { next.roi[el.dataset.roi!] = Number(el.value); });
    return next;
  };
  q('vision-settings').addEventListener('input', e => {
    const el = e.target as HTMLInputElement;
    const output = root.querySelector<HTMLOutputElement>(`[data-for="${el.dataset.setting}"]`);
    if (output) output.value = el.value;
  });
  q('vision-source').addEventListener('change', () => {
    const source = q<HTMLSelectElement>('vision-source').value;
    q('vision-camera').hidden = source !== 'camera'; q('vision-video').hidden = !['video', 'image'].includes(source);
  });
  q('vision-list-cameras').addEventListener('click', () => void control(async () => {
    const cameras = await api.get<{ index: number; name: string }[]>('/api/vision/cameras');
    q('vision-device').innerHTML = '<option value="">Utiliser l’indice manuel</option>'+cameras.filter(c => c.index <= 20).map(c => `<option value="${c.index}">${esc(c.name)} — indice ${c.index}</option>`).join('');
    const droidcam = cameras.find(c => /droidcam/i.test(c.name));
    if (droidcam) { q<HTMLSelectElement>('vision-device').value = String(droidcam.index); q<HTMLInputElement>('vision-index').value = String(droidcam.index); scheduleStart(); }
    message(cameras.length ? 'Caméras trouvées. Le choix sera appliqué automatiquement.' : 'Aucune caméra trouvée. Vérifiez DroidCam.');
  }));
  q('vision-device').addEventListener('change', () => { const value = q<HTMLSelectElement>('vision-device').value; if (value) q<HTMLInputElement>('vision-index').value = value; });
  q('vision-file').addEventListener('change', () => void control(async () => {
    videoId = null;
    const file = q<HTMLInputElement>('vision-file').files?.[0]; if (!file) return;
    if (file.size > 64*1024*1024) throw new Error('Le fichier dépasse 64 Mo.');
    message('Import du fichier…');
    const r = await fetch('/api/vision/media?name='+encodeURIComponent(file.name), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    const data = await r.json(); if (!r.ok) throw new Error(data.erreur?.message ?? 'Import impossible.');
    videoId = data.media_id; q<HTMLSelectElement>('vision-source').value = data.kind; q('vision-camera').hidden = true; q('vision-video').hidden = false; q('vision-filename').textContent = file.name; message('Fichier importé.'); await start();
  }));
  const start = async () => {
    const kind = q<HTMLSelectElement>('vision-source').value;
    if (['video','image'].includes(kind) && !videoId) throw new Error('Importez d’abord une image ou une vidéo.');
    const detector = 'hybrid';
    await api.post('/api/vision/start', kind === 'camera' ? { kind, detector, index: Number(q<HTMLInputElement>('vision-index').value) } : kind === 'video' ? { kind, detector, video_id: videoId, loop: q<HTMLInputElement>('vision-loop').checked } : { kind, detector, image_id: videoId });
    message('Flux continu en cours de démarrage…'); lastFrame = -1;
  };
  let restartTimer: ReturnType<typeof setTimeout>;
  const scheduleStart = () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (['video','image'].includes(q<HTMLSelectElement>('vision-source').value) && !videoId) return;
      void control(start);
    }, 350);
  };
  for (const id of ['vision-source', 'vision-device', 'vision-index', 'vision-loop'])
    q(id).addEventListener('change', scheduleStart);
  q('vision-save').addEventListener('click', () => void control(async () => { const s = readSettings(); await api.post('/api/vision/settings', s); settings = s; message('Réglages appliqués et sauvegardés.'); }));
  q('vision-reload').addEventListener('click', () => void control(async () => { showSettings(await api.get<Settings>('/api/vision/settings')); message('Réglages rechargés.'); }));
  q('vision-download').addEventListener('click', () => {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(readSettings(), null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'reglages-vision.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { message((e as Error).message, true); }
  });
  q('vision-import').addEventListener('change', () => void control(async () => {
    const file = q<HTMLInputElement>('vision-import').files?.[0]; if (!file) return;
    if (file.size > 100000) throw new Error('Fichier de réglages trop grand.');
    const s = JSON.parse(await file.text()); const saved = await api.post<{ settings: Settings }>('/api/vision/settings', s);
    showSettings(saved.settings); message('Réglages importés, validés et appliqués.');
  }));
  q('vision-export').addEventListener('click', () => void control(async () => {
    message('Enregistrement de la capture…');
    const data = await api.post<{ files: string[] }>('/api/vision/export');
    q('vision-downloads').innerHTML = data.files.map(name => `<a href="/api/vision/export/${encodeURIComponent(name)}" download>${esc(name.slice(37))}</a>`).join(' · ');
    message('Capture enregistrée. Téléchargez les fichiers ci-dessous.');
  }));
  void api.get<Settings>('/api/vision/settings').then(showSettings).catch(e => message(e.message, true));
  let polling = false;
  let lastRetry = 0;
  const poll = async () => {
    if (root.hidden || polling) return;
    polling = true;
    try {
      const s = await api.get<any>('/api/vision/status');
      if (initialSource) {
        initialSource = false;
        if (s.process_running && s.source?.kind) {
          q<HTMLSelectElement>('vision-source').value = s.source.kind;
          q('vision-camera').hidden = s.source.kind !== 'camera'; q('vision-video').hidden = !['video','image'].includes(s.source.kind);
          if (s.source.camera_index !== null && s.source.camera_index !== undefined) q<HTMLInputElement>('vision-index').value = String(s.source.camera_index);
        }
      }
      if (!s.process_running && !busy && Date.now()-lastRetry > 5000) {
        lastRetry = Date.now();
        if (!['video','image'].includes(q<HTMLSelectElement>('vision-source').value) || videoId) scheduleStart();
      }
      const state = ({ idle: 'Aucune source active', starting: 'Démarrage…', running: 'Détection active', ended: 'Vidéo terminée', stopped: 'Capture arrêtée', error: 'Erreur de capture' } as Record<string, string>)[s.status] ?? s.status;
      q('vision-status').textContent = `${state}${s.source?.synthetic ? ' — EXEMPLE SYNTHÉTIQUE' : s.source?.label ? ' — '+s.source.label : ''}${s.observed_at ? ' · '+dateHeure(s.observed_at) : ''}${s.stale && s.observed_at ? ' · dernière image, non actualisée' : ''}${s.error ? ' · '+s.error : ''}${s.settings_error ? ' · '+s.settings_error : ''}`;
      q<HTMLButtonElement>('vision-export').disabled = busy || s.stale || !s.process_running;
      if (s.resolution && (lastSession !== s.session_id || lastFrame !== s.frame_index)) {
        lastSession = s.session_id; lastFrame = s.frame_index;
        q('vision-images').hidden = false;
        root.querySelectorAll<HTMLImageElement>('[data-vision-image]').forEach(img => { img.src = `/api/vision/frame?kind=${img.dataset.visionImage}&t=${Date.now()}`; });
      }
      const ds = s.detections ?? [];
      q('vision-measures').innerHTML = ds.length ? `<div class="vision-table"><table><thead><tr><th>Face</th><th>Surface (px²)</th></tr></thead><tbody>${ds.map((d: any) => `<tr><td>#${d.observation_id}</td><td>${d.area_px2} px²</td></tr>`).join('')}</tbody></table></div>` : 'Aucune face détectée.';

    } catch (e) { q('vision-status').textContent = 'Module vision injoignable : '+(e as Error).message; }
    finally { polling = false; }
  };
  setInterval(() => void poll(), 300);
  void poll();
}
