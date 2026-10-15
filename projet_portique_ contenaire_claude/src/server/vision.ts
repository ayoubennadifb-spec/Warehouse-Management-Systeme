/** Pixel observations live in local files, isolated from the inventory database. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RACINE } from './config.ts';
import { ErreurMetier } from './erreurs.ts';

const finite = z.number().finite();
export const VisionSettings = z.object({
  h_min: z.number().int().min(0).max(179), h_max: z.number().int().min(0).max(179),
  s_min: z.number().int().min(0).max(255), s_max: z.number().int().min(0).max(255),
  v_min: z.number().int().min(0).max(255), v_max: z.number().int().min(0).max(255),
  min_area: finite.min(10).max(10000000), min_side_area: finite.min(10).max(10000000), max_area: finite.min(10).max(10000000),
  min_ratio: finite.min(1).max(20), max_ratio: finite.min(1).max(20),
  rectangularity: finite.min(0.5).max(1), kernel: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7), z.literal(9)]),
  roi: z.object({ x: finite.min(0).lt(100), y: finite.min(0).lt(100), width: finite.positive().max(100), height: finite.positive().max(100) }),
}).refine(s => s.h_min <= s.h_max && s.s_min <= s.s_max && s.v_min <= s.v_max
  && s.min_area <= s.max_area && s.min_side_area <= s.max_area && s.min_ratio <= s.max_ratio
  && s.roi.x+s.roi.width <= 100 && s.roi.y+s.roi.height <= 100,
  'Les minima doivent être inférieurs aux maxima et la zone doit rester dans l’image.');

export async function registerVision(app: FastifyInstance, root = RACINE): Promise<void> {
  const local = path.join(root, '.local', 'vision');
  const uploads = path.join(local, 'videos');
  const settingsPath = path.join(local, 'settings.json');
  await mkdir(uploads, { recursive: true });
  const defaults = JSON.parse(await readFile(path.join(root, 'vision', 'settings.json'), 'utf8')) as Record<string, unknown>;
  if (!existsSync(settingsPath)) await writeFile(settingsPath, JSON.stringify(defaults, null, 2));
  else {
    const saved = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    const upgraded = { ...defaults, ...saved, min_side_area: saved.min_side_area ?? defaults.min_side_area };
    if (JSON.stringify(upgraded) !== JSON.stringify(saved)) await writeFile(settingsPath, JSON.stringify(upgraded, null, 2));
  }
  let process: ChildProcess | null = null;
  let stopFile = '';
  let stderr = '';
  let launchError = '';
  let serial: Promise<unknown> = Promise.resolve();
  const pythonPath = () => globalThis.process.env.PLANNER_PYTHON ?? (existsSync(path.join(root, '..', '.venv', 'Scripts', 'python.exe')) ? path.join(root, '..', '.venv', 'Scripts', 'python.exe') : 'python');
  const exclusive = <T>(f: () => Promise<T>): Promise<T> => {
    const next = serial.then(f); serial = next.catch(() => undefined); return next;
  };
  const alive = () => !!process && process.exitCode === null && process.signalCode === null;
  const status = async (): Promise<Record<string, any>> => {
    let data: Record<string, any>;
    try { data = JSON.parse(await readFile(path.join(local, 'status.json'), 'utf8')); }
    catch { data = { status: 'idle', observed_at: null, detections: [] }; }
    const fresh = !!data.observed_at && Date.now()-Date.parse(data.observed_at) < 5000;
    if (launchError) data = { ...data, status: 'error', error: data.error || launchError };
    if (!alive() && ['running', 'starting'].includes(data.status)) data.status = 'stopped';
    return { ...data, process_running: alive(), stale: !fresh || data.status !== 'running', inventory_updated: false };
  };
  const stop = async () => {
    const child = process;
    if (!child || !alive()) return;
    await writeFile(stopFile, 'stop');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 6000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  app.get('/api/vision/status', status);
  app.get('/api/vision/cameras', async () => new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), [path.join(root, 'vision', 'worker.py'), '--list-cameras'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new ErreurMetier('CAMERAS_INDISPONIBLES', 'La liste des caméras est indisponible. Utilisez l’indice manuel.', 503)); }, 8000);
    child.stdout?.on('data', d => { output += String(d); }); child.stderr?.on('data', d => { error = (error+String(d)).slice(-1000); });
    child.on('error', () => { clearTimeout(timer); reject(new ErreurMetier('CAMERAS_INDISPONIBLES', 'Vérifiez Python et les dépendances du module Vision.', 503)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code) return reject(new ErreurMetier('CAMERAS_INDISPONIBLES', 'Liste indisponible ; indice manuel disponible. '+error, 503));
      try { resolve(JSON.parse(output)); } catch { reject(new ErreurMetier('CAMERAS_INDISPONIBLES', 'Liste des caméras illisible.', 503)); }
    });
  }));
  app.get('/api/vision/settings', async () => VisionSettings.parse(JSON.parse(await readFile(settingsPath, 'utf8'))));
  app.post('/api/vision/settings', async req => {
    const settings = VisionSettings.parse(req.body);
    const temp = settingsPath+'.'+randomUUID()+'.tmp';
    await writeFile(temp, JSON.stringify(settings, null, 2)); await rename(temp, settingsPath);
    return { settings, saved: true, inventory_updated: false };
  });
  const startCapture = async (body: unknown) => {
    const detector = 'hybrid';
    if (!existsSync(path.join(root, 'vision/models/portique-faces-seg.pt'))) throw new ErreurMetier('MODELE_ABSENT', 'Le modèle entraîné YOLO de segmentation des faces est absent.', 422);
    const b = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('demo') }),
      z.object({ kind: z.literal('camera'), index: z.number().int().min(0).max(20) }),
      z.object({ kind: z.literal('video'), video_id: z.string().uuid(), loop: z.boolean().default(true) }),
      z.object({ kind: z.literal('image'), image_id: z.string().uuid() }),
    ]).parse(body);
    let input = '0';
    if (b.kind === 'camera') input = String(b.index);
    if (b.kind === 'video') {
      const files = ['.mp4', '.avi', '.mov', '.mkv', '.webm'].map(ext => path.join(uploads, b.video_id+ext));
      const file = files.find(existsSync);
      if (!file) throw new ErreurMetier('VIDEO_ABSENTE', 'Importez une vidéo avant de lancer.', 404);
      input = file;
    }
    if (b.kind === 'image') {
      const file = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].map(ext => path.join(uploads, b.image_id+ext)).find(existsSync);
      if (!file) throw new ErreurMetier('IMAGE_ABSENTE', 'Importez une image avant de lancer.', 404);
      input = file;
    }
    await writeFile(path.join(local, 'autostart.json'), JSON.stringify({ ...b, detector }));
    await stop();
    stderr = ''; launchError = ''; stopFile = path.join(local, 'stop-'+randomUUID());
    await writeFile(path.join(local, 'status.json'), JSON.stringify({ status: 'starting', source: { kind: b.kind, synthetic: b.kind === 'demo' }, detections: [], observed_at: null }));
    const python = pythonPath();
    const args = [path.join(root, 'vision', 'worker.py'), '--headless', '--source', b.kind,
      '--input', input, '--output', local, '--settings', settingsPath, '--stop-file', stopFile, '--detector', detector];
    if (b.kind === 'video' && b.loop) args.push('--loop');
    const child = spawn(python, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...globalThis.process.env, PYTHONUTF8: '1' } });
    process = child;
    child.stderr?.on('data', data => { stderr = (stderr+String(data)).slice(-3000); });
    child.on('error', e => { launchError = `Impossible de lancer Python : ${e.message}`; if (process === child) process = null; });
    child.on('exit', code => {
      if (process === child && code && !existsSync(stopFile)) launchError = stderr || 'Module vision arrêté avec une erreur. Vérifiez OpenCV et la source.';
    });
    return { started: true, inventory_updated: false };
  };
  let automatic = false;
  let closing = false;
  let retrying = false;
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  app.post('/api/vision/start', async req => exclusive(async () => {
    const result = await startCapture(req.body); automatic = true; return result;
  }));
  app.addHook('onReady', async () => {
    if (!existsSync(path.join(local, 'autostart.json'))) return;
    automatic = true;
    const resume = async () => {
      if (closing || !automatic || alive() || retrying) return;
      retrying = true;
      try { await exclusive(async () => {
        if (closing || !automatic || alive()) return;
        await startCapture(JSON.parse(await readFile(path.join(local, 'autostart.json'), 'utf8')));
      }); } catch (e) { launchError = (e as Error).message; }
      finally { retrying = false; }
    };
    await resume();
    retryTimer = setInterval(() => void resume(), 5000);
    retryTimer.unref();
  });
  app.addHook('onClose', async () => { closing = true; automatic = false; if (retryTimer) clearInterval(retryTimer); await stop(); });
  app.post('/api/vision/stop', async () => exclusive(async () => { automatic = false; await stop(); return status(); }));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 64*1024*1024 }, (_req, body, done) => done(null, body));
  app.post('/api/vision/video', { bodyLimit: 64*1024*1024 }, async req => {
    const name = z.object({ name: z.string().min(1).max(255) }).parse(req.query).name;
    const ext = path.extname(name).toLowerCase();
    if (!['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) throw new ErreurMetier('FORMAT_VIDEO', 'Formats acceptés : MP4, AVI, MOV, MKV ou WebM.', 422);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ErreurMetier('VIDEO_VIDE', 'Le fichier vidéo est vide.', 422);
    const id = randomUUID(); await writeFile(path.join(uploads, id+ext), req.body);
    return { video_id: id, name, size: req.body.length };
  });
  app.post('/api/vision/media', { bodyLimit: 64*1024*1024 }, async req => {
    const name = z.object({ name: z.string().min(1).max(255) }).parse(req.query).name;
    const ext = path.extname(name).toLowerCase();
    const image = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext);
    if (!image && !['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) throw new ErreurMetier('FORMAT_MEDIA', 'Choisissez une image PNG/JPG/WebP/BMP ou une vidéo MP4/AVI/MOV/MKV/WebM.', 422);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ErreurMetier('MEDIA_VIDE', 'Le fichier est vide.', 422);
    const id = randomUUID(); await writeFile(path.join(uploads, id+ext), req.body);
    return { media_id: id, kind: image ? 'image' : 'video', name, size: req.body.length };
  });
  app.get('/api/vision/frame', async (req, reply) => {
    const kind = z.object({ kind: z.enum(['original', 'mask', 'annotated']) }).parse(req.query).kind;
    try { return reply.header('Cache-Control', 'no-store').type('image/jpeg').send(await readFile(path.join(local, kind+'.jpg'))); }
    catch { return reply.status(404).send({ erreur: { message: 'Aucune image disponible.' } }); }
  });
  const captureExport = async () => {
    const current = await status();
    if (!alive() || current.stale) throw new ErreurMetier('VISION_INACTIVE', 'Lancez une source active avant de capturer les mesures.', 409);
    const token = randomUUID(); const target = path.join(local, 'export-request.json');
    const temp = target+'.tmp'; await writeFile(temp, JSON.stringify({ token })); await rename(temp, target);
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 100));
      const data = await status();
      if (data.latest_export?.token === token) return data.latest_export;
      if (!alive()) break;
    }
    throw new ErreurMetier('EXPORT_INDISPONIBLE', 'La capture n’a pas abouti. Vérifiez la source puis réessayez.', 503);
  };
  app.post('/api/vision/export', async () => exclusive(captureExport));
  app.get('/api/vision/calibration', async () => {
    try { return JSON.parse(await readFile(path.join(local, 'calibration.json'), 'utf8')); }
    catch { return null; }
  });
  app.post('/api/vision/calibration/snapshot', async () => exclusive(async () => {
    const result = await captureExport();
    const observation = JSON.parse(await readFile(path.join(local, 'exports', result.token+'-measures.json'), 'utf8'));
    return { image: '/api/vision/export/'+result.token+'-original.png', observation };
  }));
  app.post('/api/vision/calibration', async req => exclusive(async () => {
    const coordinate = z.tuple([finite, finite]);
    const profile = z.object({
      container_mm: z.object({ length: finite.positive().max(100000), width: finite.positive().max(100000), height: finite.positive().max(100000) }),
      resolution: z.object({ width: z.number().int().positive().max(10000), height: z.number().int().positive().max(10000) }),
      source: z.object({ kind: z.enum(['camera', 'video', 'image', 'demo']), camera_index: z.number().int().min(0).max(20).nullable() }),
      levels: z.array(z.object({ level: z.number().int().min(1).max(3), points: z.array(z.object({ pixel: coordinate, world: coordinate })).min(4).max(60) })).length(3),
      max_error: finite.min(0.01).max(0.3).default(0.12), min_gap: finite.min(0.01).max(0.3).default(0.03),
    }).parse(req.body);
    if (profile.levels.some(l => l.points.some(p => p.pixel[0]<0 || p.pixel[1]<0 || p.pixel[0]>=profile.resolution.width || p.pixel[1]>=profile.resolution.height)))
      throw new ErreurMetier('REPERES_INVALIDES', 'Un repère sort de l’image.', 422);
    const fitted = await new Promise<any>((resolve, reject) => {
      const child = spawn(pythonPath(), [path.join(root, 'vision', 'calibration.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...globalThis.process.env, PYTHONUTF8: '1' } });
      let output = ''; let error = '';
      const timer = setTimeout(() => { child.kill(); reject(new ErreurMetier('CALIBRATION_TIMEOUT', 'Calcul de calibration trop long.', 503)); }, 15000);
      child.stdout.on('data', d => { output += String(d); }); child.stderr.on('data', d => { error = (error+String(d)).slice(-1000); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); if (code) reject(new ErreurMetier('CALIBRATION_INVALIDE', error || 'Repères invalides.', 422)); else { try { resolve(JSON.parse(output)); } catch (e) { reject(e); } } });
      child.stdin.end(JSON.stringify(profile));
    });
    fitted.saved_at = new Date().toISOString();
    const file = path.join(local, 'calibration.json'); const temp = file+'.tmp';
    await writeFile(temp, JSON.stringify(fitted, null, 2)); await rename(temp, file);
    return { profile: fitted, inventory_updated: false };
  }));
  app.get('/api/vision/export/:name', async (req, reply) => {
    const name = z.object({ name: z.string().regex(/^[a-f0-9-]{36}-(original\.png|mask\.png|annotated\.png|measures\.json|measures\.csv)$/) }).parse(req.params).name;
    const ext = path.extname(name);
    try { return reply.header('Content-Disposition', `attachment; filename="${name}"`).type(ext === '.png' ? 'image/png' : ext === '.json' ? 'application/json' : 'text/csv; charset=utf-8').send(await readFile(path.join(local, 'exports', name))); }
    catch { return reply.status(404).send({ erreur: { message: 'Capture introuvable.' } }); }
  });
}
