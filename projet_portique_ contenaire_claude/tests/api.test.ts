/**
 * Intégration HTTP : vrai serveur, vraie base (DATABASE_URL_TEST), simulation réelle.
 * Persistance après redémarrage, interruption, flux SSE avec reprise, mode matériel.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { nouvelleBase } from './aide.ts';

let pool: pg.Pool;
const PORT = 3098;
const B = `http://127.0.0.1:${PORT}`;
type Srv = { arreter: () => Promise<void> };
let srv: Srv | null = null;

async function demarrer(mode: 'SIMULATION' | 'MATERIEL' = 'SIMULATION'): Promise<Srv> {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  process.env.PORT = String(PORT);
  process.env.SOURCE_EVENEMENTS = mode;
  const { demarrerServeur } = await import('../src/server/index.ts');
  const log = console.log;
  console.log = () => undefined;
  try {
    return await demarrerServeur();
  } finally {
    console.log = log;
  }
}

const post = async (url: string, corps: unknown = {}) => {
  const r = await fetch(B + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps) });
  return { statut: r.status, json: await r.json() };
};
const get = async (url: string) => (await fetch(B + url)).json();
const attendre = async (f: () => Promise<boolean>, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('délai dépassé');
};

/** Lit le flux SSE jusqu'à n événements « evenement ». */
async function lireSSE(url: string, n: number, entetes: Record<string, string> = {}, action?: () => Promise<void>) {
  const ctrl = new AbortController();
  const r = await fetch(B + url, { headers: entetes, signal: ctrl.signal });
  const lecteur = r.body!.getReader();
  const dec = new TextDecoder();
  let tampon = '';
  const evs: { id: number; data: any }[] = [];
  let lance = false;
  const fin = Date.now() + 20000;
  while (evs.length < n && Date.now() < fin) {
    if (!lance && action && tampon.includes('event: battement')) {
      lance = true;
      await action();
    }
    const { value, done } = await lecteur.read();
    if (done) break;
    tampon += dec.decode(value, { stream: true });
    let i;
    while ((i = tampon.indexOf('\n\n')) >= 0) {
      const bloc = tampon.slice(0, i);
      tampon = tampon.slice(i + 2);
      if (!lance && action && bloc.includes('event: battement')) {
        lance = true;
        await action();
      }
      if (!bloc.includes('event: evenement')) continue;
      const id = Number(/^id: (\d+)/m.exec(bloc)![1]);
      evs.push({ id, data: JSON.parse(/^data: (.*)$/m.exec(bloc)![1]) });
    }
  }
  ctrl.abort();
  return evs;
}

before(async () => {
  pool = await nouvelleBase();
});
after(async () => {
  await srv?.arreter().catch(() => undefined);
  await pool.end();
});

test('API : santé, état, refus expliqué en français', async () => {
  srv = await demarrer();
  const s = await get('/api/sante');
  assert.equal(s.base.ok, true);
  assert.equal(s.mode, 'SIMULATION');
  assert.deepEqual(s.base.migrations, ['001_schema_initial.sql', '002_regles_integrite.sql', '003_extensions_futures.sql', '004_degagement.sql']);
  const e = await get('/api/etat');
  const mock=await post('/api/hardware/self-test');assert.equal(mock.json.passed,true);assert.equal(mock.json.physical_commands_enabled,false);assert.deepEqual((await get('/api/etat')).conteneurs,e.conteneurs);
  assert.equal(e.indicateurs.emplacements_total, 147);
  assert.equal(e.indicateurs.positions_sol_total, 49);
  const vide = e.plan.geometrie.positions.find((p: any) => !e.conteneurs.some((c: any) => c.code_position === p.code));
  const n2 = e.plan.geometrie.emplacements.find((x: any) => x.position_sol_id === vide.id && x.niveau === 2);
  const r = await post('/api/missions', { conteneur_id: e.conteneurs[0].id, destination_emplacement_id: n2.id });
  assert.equal(r.statut, 409);
  assert.match(r.json.erreur.message, /support|sommet/);
  const inv = await post('/api/missions', { conteneur_id: 'x' });
  assert.equal(inv.statut, 422);
});

test('SSE : événements ordonnés, rejeu après reconnexion (Last-Event-ID)', async () => {
  const e = await get('/api/etat');
  const depart = e.dernier_evenement_id;
  const camion = async () => {
    await post('/api/camions/arrivee', { camion_code: 'SSE-1' });
  };
  const evs = await lireSSE('/api/flux', 1, {}, camion);
  assert.equal(evs[0].data.type, 'CAMION_ARRIVE');
  assert.ok(evs[0].id > depart);
  // Reconnexion en annonçant le dernier événement reçu AVANT la coupure : rejeu sans perte
  const v = (await get('/api/etat')).visites.find((x: any) => x.camion_code === 'SSE-1');
  await post(`/api/visites/${v.id}/depart`);
  const rejoues = await lireSSE('/api/flux', 1, { 'Last-Event-ID': String(evs[0].id) });
  assert.equal(rejoues[0].data.type, 'CAMION_PARTI');
  assert.ok(rejoues[0].id > evs[0].id);
});

test('persistance après redémarrage pendant un transfert : interruption signalée, rien d’inventé', async () => {
  const e = await get('/api/etat');
  const top = e.conteneurs.find((c: any) => c.code === 'DEMO-T01');
  const libre = e.plan.geometrie.emplacements.find(
    (x: any) => x.niveau === 1 && !e.conteneurs.some((c: any) => c.emplacement_id === x.id) && !e.reservations.some((r: any) => r.emplacement_id === x.id),
  );
  const m = await post('/api/missions', { conteneur_id: top.id, destination_emplacement_id: libre.id });
  assert.equal(m.statut, 201);
  // attendre la prise confirmée (conteneur en transfert), puis couper le serveur
  await attendre(async () => (await get(`/api/missions/${m.json.id}`)).prise_confirmee_le !== null);
  await post('/api/simulation/pause');
  const avant = await get('/api/etat');
  await srv!.arreter();
  srv = null;
  // Redémarrage : l'état vient de PostgreSQL
  srv = await demarrer();
  const apres = await get('/api/etat');
  assert.equal(apres.indicateurs.conteneurs_presents, avant.indicateurs.conteneurs_presents);
  assert.equal(apres.versions.length, avant.versions.length);
  const mi = await get(`/api/missions/${m.json.id}`);
  // la mission avait été suspendue (pause) : elle reste suspendue et reprend depuis la position enregistrée
  assert.equal(mi.statut, 'SUSPENDUE');
  const r = await post(`/api/missions/${m.json.id}/reprendre`);
  assert.equal(r.statut, 200);
  await post('/api/simulation/vitesse', { facteur: 20 });
  await attendre(async () => (await get(`/api/missions/${m.json.id}`)).statut === 'TERMINEE');
  const c = (await get('/api/etat')).conteneurs.find((x: any) => x.id === top.id);
  assert.equal(c.emplacement_id, libre.id);

  // Coupure brutale en cours d'exécution (sans pause) → au redémarrage : INTERROMPUE + INCERTAINE
  const e2 = await get('/api/etat');
  const src = e2.conteneurs.find((x: any) => x.id === top.id);
  const dest2 = e2.plan.geometrie.emplacements.find((x: any) => x.niveau === 1 && !e2.conteneurs.some((k: any) => k.emplacement_id === x.id));
  await post('/api/simulation/vitesse', { facteur: 1 });
  const m2 = await post('/api/missions', { conteneur_id: src.id, destination_emplacement_id: dest2.id });
  await attendre(async () => (await get(`/api/missions/${m2.json.id}`)).prise_confirmee_le !== null);
  await srv!.arreter();
  srv = await demarrer();
  const m2b = await get(`/api/missions/${m2.json.id}`);
  assert.equal(m2b.statut, 'INTERROMPUE');
  assert.match(m2b.motif_fin, /Redémarrage du serveur/);
  const e3 = await get('/api/etat');
  const c3 = e3.conteneurs.find((x: any) => x.id === src.id);
  assert.equal(c3.etat, 'INCERTAINE');
  assert.equal(c3.emplacement_id, null, 'ni à la source ni à la destination : position à confirmer');
  assert.ok(e3.alertes.some((a: any) => a.mission_id === m2.json.id));
  await attendre(async () => /interrompue/.test((await get('/api/sante')).source.bloque ?? ''), 3000);
  // L'opérateur constate que le conteneur est toujours tenu : reprise
  const rep = await post(`/api/missions/${m2.json.id}/reprendre`, { conteneur_toujours_tenu: true });
  assert.equal(rep.statut, 200);
  await post('/api/simulation/vitesse', { facteur: 20 });
  await attendre(async () => (await get(`/api/missions/${m2.json.id}`)).statut === 'TERMINEE');
  const t = await get(`/api/missions/${m2.json.id}`);
  assert.ok(t.trajets.length >= 2, 'trajet recalculé (nouvelle version) après reprise');
  assert.ok(t.trajets.every((x: any) => x.optimise === true));
  await srv!.arreter();
  srv = null;
});

test('incident simulé pendant le transport puis déclaration de la position réelle', async () => {
  srv = await demarrer();
  try {
    await incident();
  } finally {
    await srv!.arreter();
    srv = null;
  }
});

async function incident(): Promise<void> {
  const e = await get('/api/etat');
  const c = e.conteneurs.find((x: any) => x.type_emplacement === 'CASE' && !e.conteneurs.some((k: any) => k.code_position === x.code_position && k.niveau > x.niveau));
  const d = e.plan.geometrie.emplacements.find(
    (x: any) => x.niveau === 1 && !e.conteneurs.some((k: any) => k.emplacement_id === x.id) && !e.reservations.some((r: any) => r.emplacement_id === x.id),
  );
  const m = await post('/api/missions', { conteneur_id: c.id, destination_emplacement_id: d.id });
  assert.equal(m.statut, 201, JSON.stringify(m.json));
  await attendre(async () => (await get(`/api/missions/${m.json.id}`)).prise_confirmee_le !== null);
  const inc = await post('/api/simulation/incident', { motif: 'Présence humaine simulée' });
  assert.equal(inc.json.mission_id, m.json.id);
  const e2 = await get('/api/etat');
  assert.equal(e2.conteneurs.find((x: any) => x.id === c.id).etat, 'INCERTAINE');
  // Aucune nouvelle mission n'est exécutée tant que l'incertitude n'est pas levée (état mis à jour au cycle suivant)
  await attendre(async () => /interrompue/.test((await get('/api/sante')).source.bloque ?? ''), 3000);
  // L'opérateur constate le conteneur à sa destination prévue et le déclare
  const decl = await post(`/api/conteneurs/${c.id}/declarer-position`, { emplacement_id: d.id, commentaire: 'constaté' });
  assert.equal(decl.statut, 200, JSON.stringify(decl.json));
  const e3 = await get('/api/etat');
  assert.equal(e3.conteneurs.find((x: any) => x.id === c.id).emplacement_id, d.id);
  assert.equal((await get(`/api/missions/${m.json.id}`)).statut, 'ANNULEE');
  assert.equal(e3.alertes.filter((a: any) => a.mission_id === m.json.id).length, 0);
}

test('mode matériel : honnêteté de l’état et confirmations idempotentes par HTTP', async () => {
  srv = await demarrer('MATERIEL');
  let s = await get('/api/sante');
  assert.equal(s.source.connecte, false);
  assert.match(s.source.description, /Aucun matériel connecté/);
  const pause = await post('/api/simulation/pause');
  assert.equal(pause.statut, 409);
  await post('/api/materiel/battement', { pont: 'pont-test', nature: 'TEST' });
  s = await get('/api/sante');
  assert.equal(s.source.connecte, true);
  assert.match(s.source.description, /TEST/);
  const e = await get('/api/etat');
  const c = e.conteneurs.find((x: any) => x.type_emplacement === 'CASE' && !e.conteneurs.some((k: any) => k.code_position === x.code_position && k.niveau > x.niveau));
  const d = e.plan.geometrie.emplacements.find(
    (x: any) => x.niveau === 1 && !e.conteneurs.some((k: any) => k.emplacement_id === x.id) && !e.reservations.some((r: any) => r.emplacement_id === x.id),
  );
  const m = await post('/api/missions', { conteneur_id: c.id, destination_emplacement_id: d.id });
  assert.equal(m.statut, 201, JSON.stringify(m.json));
  await post(`/api/missions/${m.json.id}/demarrer`);
  const conf = { source: 'MATERIEL', cle: 'PLC-0001', type: 'PRISE', mission_id: m.json.id, horodatage_source: new Date().toISOString() };
  const a = await post('/api/confirmations', conf);
  const b = await post('/api/confirmations', conf);
  assert.equal(a.json.resultat, 'APPLIQUEE');
  assert.equal(b.json.deja_recue, true);
  const dep = await post('/api/confirmations', { ...conf, cle: 'PLC-0002', type: 'DEPOT' });
  assert.equal(dep.json.resultat, 'APPLIQUEE');
  assert.equal((await get(`/api/missions/${m.json.id}`)).statut, 'TERMINEE');
});
