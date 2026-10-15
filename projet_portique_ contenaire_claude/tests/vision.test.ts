import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registerVision } from '../src/server/vision.ts';
import { RACINE } from '../src/server/config.ts';

test('Vision: settings, synthetic capture, coherent exports and source errors without a database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'portique-vision-'));
  const previous = process.env.PLANNER_PYTHON;
  process.env.PLANNER_PYTHON = path.join(RACINE, '..', '.venv', 'Scripts', 'python.exe');
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => {
    const error = e as Error & { statut?: number };
    reply.status(e instanceof ZodError ? 422 : error.statut ?? 500).send({ erreur: { message: error.message } });
  });
  try {
    await mkdir(path.join(root, 'vision'));
    for (const file of ['settings.json', 'worker.py', 'capture.py', 'detection.py', 'calibration.py', 'geometry.py']) await copyFile(path.join(RACINE, 'vision', file), path.join(root, 'vision', file));
    await mkdir(path.join(root, 'vision/models'));
    await copyFile(path.join(RACINE, 'vision/models/portique-faces-seg.pt'), path.join(root, 'vision/models/portique-faces-seg.pt'));
    await registerVision(app, root); await app.ready();
    const settings = (await app.inject('/api/vision/settings')).json();
    assert.equal((await app.inject({ method: 'POST', url: '/api/vision/settings', payload: { ...settings, h_min: 170, h_max: 100 } })).statusCode, 422);
    const updated = { ...settings, min_area: 700 };
    assert.equal((await app.inject({ method: 'POST', url: '/api/vision/settings', payload: updated })).statusCode, 200);
    assert.equal((await app.inject('/api/vision/settings')).json().min_area, 700);
    assert.equal((await app.inject({ method: 'POST', url: '/api/vision/export', payload: {} })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/vision/start', payload: { kind: 'camera', index: -1 } })).statusCode, 422);
    await app.inject({ method: 'POST', url: '/api/vision/start', payload: { kind: 'demo' } });
    let status: any;
    for (let i = 0; i < 600; i++) {
      status = (await app.inject('/api/vision/status')).json();
      if (status.status === 'running' || status.status === 'error') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(status.status, 'running', JSON.stringify(status));
    assert.equal(status.source.synthetic, true);
    assert.equal(status.detector, 'hybrid');
    assert.ok(status.detections.every((d: any) => d.method === 'yolo-seg' && d.polygon_px?.length >= 3 && d.object_box_px));
    assert.equal(status.inventory_updated, false);
    assert.equal(status.stale, false);
    assert.equal((await app.inject('/api/vision/frame?kind=annotated')).headers['content-type'], 'image/jpeg');
    const response = await app.inject({ method: 'POST', url: '/api/vision/export', payload: {} });
    assert.equal(response.statusCode, 200, response.body+' '+(await app.inject('/api/vision/status')).body);
    const exported = response.json();
    assert.equal(exported.files.length, 5);
    const data = JSON.parse(await readFile(path.join(root, '.local/vision/exports', exported.files[3]), 'utf8'));
    assert.ok(data.detections.every((d: any) => d.method === 'yolo-seg'));
    assert.equal(data.inventory_updated, false);
    assert.equal((await app.inject('/api/vision/export/'+exported.files[4])).statusCode, 200);
    const snapshot = await app.inject({ method: 'POST', url: '/api/vision/calibration/snapshot', payload: {} });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().observation.resolution.width, 960);
    assert.equal((await app.inject(snapshot.json().image)).statusCode, 200);
    const pixels = [[0,0],[900,0],[900,500],[0,500]];
    const profile = { container_mm: { length: 160, width: 80, height: 30 }, resolution: { width: 960, height: 540 }, source: { kind: 'demo', camera_index: null },
      levels: [1,2,3].map(level => ({ level, points: pixels.map(pixel => ({ pixel, world: pixel.map(v => v*(1-(level-1)*0.2)) })) })) };
    const saved = await app.inject({ method: 'POST', url: '/api/vision/calibration', payload: profile });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().profile.levels.length, 3);
    assert.equal((await app.inject('/api/vision/calibration')).json().container_mm.height, 30);
    const invalid = { ...profile, levels: profile.levels.map(l => ({ ...l, points: l.points.map((p,i) => ({ pixel: [i*10,10], world: [i*10,0] })) })) };
    assert.equal((await app.inject({ method: 'POST', url: '/api/vision/calibration', payload: invalid })).statusCode, 422);
    assert.equal((await app.inject('/api/vision/calibration')).json().container_mm.height, 30);
    await app.inject({ method: 'POST', url: '/api/vision/stop', payload: {} });
    assert.equal((await app.inject('/api/vision/status')).json().process_running, false);
    const uploaded = (await app.inject({ method: 'POST', url: '/api/vision/video?name=test.mp4', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('invalid video') })).json();
    await app.inject({ method: 'POST', url: '/api/vision/start', payload: { kind: 'video', video_id: uploaded.video_id, loop: false } });
    for (let i = 0; i < 600; i++) {
      status = (await app.inject('/api/vision/status')).json();
      if (status.status === 'error') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(status.status, 'error');
    assert.equal((await app.inject('/api/vision/export/..%2Fsettings.json')).statusCode, 422);
  } finally {
    await app.close(); await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PLANNER_PYTHON; else process.env.PLANNER_PYTHON = previous;
  }
});
