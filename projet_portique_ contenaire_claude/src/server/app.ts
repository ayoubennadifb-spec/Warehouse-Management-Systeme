/** API HTTP locale : commandes (POST), lectures (GET) et flux temps réel (SSE). */
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import { RACINE, parametresParDefaut, type ModeSource } from './config.ts';
import { transaction, une, toutes } from './db.ts';
import { ErreurMetier } from './erreurs.ts';
import type { Diffuseur } from './temps-reel.ts';
import type { SourceEvenements } from './sources/types.ts';
import { SimulationSource } from './sources/simulation.ts';
import { SourceMateriel } from './sources/materiel.ts';
import { calculerPlan } from '../shared/geometrie.ts';
import { chargerEtat, lireEvenements } from './domaine/etat.ts';
import { annuler, confirmer, creerMission, demarrerMission, interrompre, lireMission, listerMissions, reprendre, suspendre } from './domaine/missions.ts';
import { arriveeCamion, departCamion, statutPoste } from './domaine/camions.ts';
import { bloquerPosition, declarerPosition, destinationsPossibles, detailConteneur } from './domaine/conteneurs.ts';
import { calculer, preparer, lancer } from './domaine/degagement.ts';
import { activerVersion, analyserActivation, creerVersion } from './domaine/plans.ts';
import { registerVision } from './vision.ts';

// ------------------------------------------------------------------ schémas d'entrée
const nb = z.number().finite();
const cote = z.enum(['X_MIN', 'X_MAX']);
export const SchemaParametres = z.object({
  libelle: z.string().trim().min(1).max(200),
  espace: z.object({ longueur_x_mm: nb, largeur_y_mm: nb }),
  zones: z.object({ transport_longueur_x_mm: nb, transport_cote: cote }),
  conteneur: z.object({ longueur_mm: nb, largeur_mm: nb, hauteur_mm: nb }),
  grille: z.object({
    nb_positions_x: z.number().int(),
    nb_positions_y: z.number().int(),
    nb_niveaux_max: z.number().int(),
    marge_x_mm: nb.nullable(),
    espacement_x_mm: nb.nullable(),
    marge_y_mm: nb.nullable(),
    espacement_y_mm: nb.nullable(),
  }),
  capacite: z.object({ nb_conteneurs_max: z.number().int(), perimetre: z.enum(['ZONE', 'STOCKAGE']) }),
  camion: z.object({
    cabine_longueur_mm: nb,
    cabine_largeur_mm: nb,
    cabine_hauteur_mm: nb,
    plateau_longueur_mm: nb,
    plateau_largeur_mm: nb,
    plateau_hauteur_mm: nb,
  }),
  postes: z.object({
    nb_postes: z.number().int(),
    cote_cabine: cote,
    positions: z.array(z.object({ code: z.string().trim().min(1).max(20), centre_x_mm: nb, centre_y_mm: nb })).nullable(),
  }),
});
const point = z.object({ x: nb, y: nb, z: nb });
const Id = z.object({ id: z.coerce.number().int().positive() });

export interface Services {
  pool: pg.Pool;
  diffuseur: Diffuseur;
  source: SourceEvenements;
  mode: ModeSource;
}

export async function construireApp(s: Services, opts: { journal?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.journal ? { level: 'warn' } : false });
  const { pool, diffuseur, source } = s;
  await registerVision(app);
  const tx = <T>(f: Parameters<typeof transaction<T>>[1]) => transaction<T>(pool, f);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ErreurMetier) return reply.status(err.statut).send({ erreur: { code: err.code, message: err.message, details: err.details ?? null } });
    if (err instanceof ZodError)
      return reply.status(422).send({
        erreur: { code: 'REQUETE_INVALIDE', message: err.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '), details: err.issues },
      });
    const e = err as { code?: string; message?: string; statusCode?: number };
    if (e.code && ['ECONNREFUSED', 'ENOTFOUND', '57P01', '08006', '08001', '28P01', '3D000'].includes(e.code))
      return reply.status(503).send({ erreur: { code: 'BASE_INDISPONIBLE', message: `Base de données indisponible : ${e.message}` } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ erreur: { code: 'REQUETE_INVALIDE', message: e.message } });
    console.error(err);
    return reply.status(500).send({ erreur: { code: 'ERREUR_INTERNE', message: e.message ?? 'Erreur interne' } });
  });

  const sim = () => {
    if (!(source instanceof SimulationSource))
      throw new ErreurMetier('MODE_MATERIEL', 'Commande de simulation indisponible : le serveur est en mode MATERIEL.', 409);
    return source;
  };
  const materiel = () => {
    if (!(source instanceof SourceMateriel)) throw new ErreurMetier('MODE_SIMULATION', 'Le serveur est en mode SIMULATION (aucun pont matériel attendu).', 409);
    return source;
  };
  const sourceAction = () => (s.mode === 'MATERIEL' ? 'MATERIEL' : 'SIMULATION');

  // ---------------------------------------------------------------- lectures
  app.get('/api/sante', async () => {
    await diffuseur.verifierBase();
    const migrations = await toutes(pool, 'SELECT version FROM schema_migrations ORDER BY version').catch(() => []);
    const db = await une(pool, 'SELECT current_database() AS base, version() AS version').catch(() => null);
    return { serveur_le: new Date().toISOString(), mode: s.mode, base: { ...diffuseur.base, nom: db?.base ?? null, version: db?.version ?? null, migrations: migrations.map((m) => m.version) }, source: source.etat() };
  });

  app.get('/api/etat', async () => ({ ...(await chargerEtat(pool)), mode: s.mode, source: source.etat(), base: diffuseur.base }));

  app.get('/api/evenements', async (req) => {
    const q = z.object({ apres: z.coerce.number().int().optional(), avant: z.coerce.number().int().optional(), limite: z.coerce.number().int().optional() }).parse(req.query);
    return lireEvenements(pool, q);
  });

  app.get('/api/missions', async (req) => listerMissions(pool, z.object({ limite: z.coerce.number().int().default(100) }).parse(req.query).limite));
  app.get('/api/missions/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const m = await lireMission(pool, id);
    const reservations = await toutes(pool, `SELECT r.*, e.code FROM reservation r JOIN emplacement e ON e.id = r.emplacement_id WHERE mission_id = $1`, [id]);
    const trajets = await toutes(pool, `SELECT * FROM trajet WHERE mission_id = $1 ORDER BY version`, [id]);
    const confirmations = await toutes(pool, `SELECT * FROM confirmation WHERE mission_id = $1 ORDER BY id`, [id]);
    return { ...m, reservations, trajets, confirmations };
  });

  app.get('/api/conteneurs/:id', async (req) => detailConteneur(pool, Id.parse(req.params).id));
  app.get('/api/conteneurs/:id/destinations', async (req) => destinationsPossibles(pool, Id.parse(req.params).id));

  app.get('/api/plans/defaut', async () => parametresParDefaut());
  app.post('/api/plans/verifier', async (req) => calculerPlan(SchemaParametres.parse(req.body)));
  app.get('/api/plans/:id/impact', async (req) => analyserActivation(pool, Id.parse(req.params).id));

  app.get('/api/hardware/status',async()=>calculer({mode:'hardware-status'}));
  app.post('/api/hardware/self-test',async()=>calculer({mode:'hardware-test'}));
  const apercus=new Map<string,{plan:any,container:number,dest:number}>();
  app.post('/api/degagement/apercu',async(req)=>{
    sim();const b=z.object({conteneur_id:z.number().int().positive(),destination_emplacement_id:z.number().int().positive()}).parse(req.body);
    const plan=await preparer(pool,b.conteneur_id,b.destination_emplacement_id);
    const key=plan.revision+':'+b.conteneur_id+':'+b.destination_emplacement_id;
    if(apercus.size>16)apercus.delete(apercus.keys().next().value!);
    apercus.set(key,{plan,container:b.conteneur_id,dest:b.destination_emplacement_id});return plan;
  });
  app.post('/api/degagement/lancer',async(req)=>{
    sim();const b=z.object({conteneur_id:z.number().int().positive(),destination_emplacement_id:z.number().int().positive(),revision:z.string()}).parse(req.body);
    const key=b.revision+':'+b.conteneur_id+':'+b.destination_emplacement_id;const preview=apercus.get(key);
    if(!preview)throw new ErreurMetier('APERCU_ABSENT','Calculez le plan avant de lancer.',409);
    const op=await tx(c=>lancer(c,b.conteneur_id,b.destination_emplacement_id,preview.plan));apercus.delete(key);return op;
  });
  app.get('/api/health',async()=>({app:'portique-lab',version:'claude-fusion-1',instance:process.env.PORTIQUE_INSTANCE_ID,database:'PostgreSQL'}));
  app.get('/api/state',async()=>chargerEtat(pool));
  app.addHook('preHandler',async(req)=>{
    if(req.method!=='POST')return;
    if(req.url.startsWith('/api/vision/'))return;
    await pool.query("UPDATE operation_degagement op SET statut=m.statut FROM mission m WHERE op.mission_id=m.id AND op.statut='EN_COURS' AND m.statut IN ('INTERROMPUE','ANNULEE')");
    const url=req.url;
    if(url==='/api/hardware/self-test'||url.startsWith('/api/simulation/')||/^\/api\/missions\/\d+\/(suspendre|reprendre|interrompre|annuler)$/.test(url)||url==='/api/degagement/apercu'||url==='/api/degagement/lancer')return;
    if(await une(pool,"SELECT 1 FROM operation_degagement WHERE statut='EN_COURS'"))throw new ErreurMetier('DEGAGEMENT_ACTIF','Terminez ou interrompez le dégagement avant de modifier la scène.',409);
  });
  // ---------------------------------------------------------------- commandes métier
  app.post('/api/missions', async (req, reply) => {
    const b = z.object({ conteneur_id: z.number().int(), destination_emplacement_id: z.number().int() }).parse(req.body);
    reply.status(201);
    return tx((c) => creerMission(c, b, 'OPERATEUR'));
  });
  app.post('/api/missions/:id/suspendre', async (req) => tx((c) => suspendre(c, Id.parse(req.params).id, 'OPERATEUR')));
  app.post('/api/missions/:id/reprendre', async (req) => {
    const b = z.object({ conteneur_toujours_tenu: z.boolean().optional() }).parse(req.body ?? {});
    return tx((c) => reprendre(c, Id.parse(req.params).id, 'OPERATEUR', b));
  });
  app.post('/api/missions/:id/interrompre', async (req) => {
    const b = z.object({ motif: z.string().trim().min(1).max(300) }).parse(req.body);
    return tx((c) => interrompre(c, Id.parse(req.params).id, b.motif, 'OPERATEUR'));
  });
  app.post('/api/missions/:id/annuler', async (req) => {
    const b = z.object({ motif: z.string().trim().min(1).max(300).default('Annulation opérateur') }).parse(req.body ?? {});
    return tx((c) => annuler(c, Id.parse(req.params).id, b.motif, 'OPERATEUR'));
  });
  // Utilisé par un pont matériel (en simulation, le simulateur démarre lui-même les missions)
  app.post('/api/missions/:id/demarrer', async (req) => {
    materiel();
    return tx((c) => demarrerMission(c, Id.parse(req.params).id, 'MATERIEL'));
  });

  app.post('/api/confirmations', async (req) => {
    const b = z
      .object({
        source: z.literal('MATERIEL'),
        cle: z.string().trim().min(1).max(200),
        type: z.enum(['PRISE', 'DEPOT']),
        mission_id: z.number().int(),
        horodatage_source: z.iso.datetime({ offset: true }).nullable().optional(),
        position: point.nullable().optional(),
      })
      .parse(req.body);
    return tx((c) => confirmer(c, b));
  });

  app.post('/api/conteneurs/:id/declarer-position', async (req) => {
    const b = z
      .object({ emplacement_id: z.number().int().nullable().optional(), sorti: z.boolean().optional(), commentaire: z.string().max(300).nullable().optional() })
      .parse(req.body);
    await tx((c) => declarerPosition(c, Id.parse(req.params).id, b, 'OPERATEUR'));
    return { ok: true };
  });

  app.post('/api/camions/arrivee', async (req, reply) => {
    const b = z
      .object({
        camion_code: z.string().trim().min(1).max(40),
        conteneur_code: z.string().trim().max(40).nullable().optional(),
        poste_code: z.string().trim().max(20).nullable().optional(),
      })
      .parse(req.body);
    const r = await tx((c) => arriveeCamion(c, b, 'OPERATEUR'));
    if (!r.accepte) return reply.status(409).send({ erreur: { code: r.code, message: `Arrivée refusée : ${r.motif}`, details: r } });
    return reply.status(201).send(r);
  });
  app.post('/api/visites/:id/depart', async (req) => tx((c) => departCamion(c, Id.parse(req.params).id, 'OPERATEUR')));

  app.post('/api/positions/:id/blocage', async (req) => {
    const b = z.object({ motif: z.string().trim().max(200).nullable() }).parse(req.body);
    await tx((c) => bloquerPosition(c, Id.parse(req.params).id, b.motif, 'OPERATEUR'));
    return { ok: true };
  });
  app.post('/api/postes/:id/statut', async (req) => {
    const b = z.object({ hors_service: z.boolean(), motif: z.string().trim().max(200).nullable().optional() }).parse(req.body);
    await tx((c) => statutPoste(c, Id.parse(req.params).id, b.hors_service, b.motif ?? null, 'OPERATEUR'));
    return { ok: true };
  });

  app.post('/api/plans', async (req, reply) => {
    const b = z.object({ parametres: SchemaParametres, commentaire: z.string().max(500).nullable().optional() }).parse(req.body);
    const r = await tx((c) => creerVersion(c, b.parametres, 'OPERATEUR', b.commentaire ?? null));
    reply.status(201);
    return { id: r.id, numero: r.numero, avertissements: r.plan.avertissements, analyse: await analyserActivation(pool, r.id) };
  });
  app.post('/api/plans/:id/activer', async (req) => {
    const b = z.object({ forcer: z.boolean().default(false) }).parse(req.body ?? {});
    return tx((c) => activerVersion(c, Id.parse(req.params).id, { forcer: b.forcer, source: 'OPERATEUR' }));
  });

  app.post('/api/alertes/:id/acquitter', async (req) => {
    await pool.query(`UPDATE alerte SET statut = 'ACQUITTEE', acquittee_le = now() WHERE id = $1 AND statut = 'OUVERTE'`, [Id.parse(req.params).id]);
    diffuseur.signalerSource();
    return { ok: true };
  });

  // ---------------------------------------------------------------- simulation
  app.post('/api/simulation/pause', async () => {
    await sim().mettreEnPause();
    return source.etat();
  });
  app.post('/api/simulation/reprise', async () => {
    await sim().reprendreSimulation();
    return source.etat();
  });
  app.post('/api/simulation/vitesse', async (req) => {
    sim().definirVitesse(z.object({ facteur: z.number().positive() }).parse(req.body).facteur);
    return source.etat();
  });
  app.post('/api/simulation/incident', async (req) => {
    const b = z.object({ motif: z.string().trim().min(1).max(200).default('Incident simulé') }).parse(req.body ?? {});
    try {
      return { mission_id: await sim().incident(b.motif) };
    } catch (e) {
      if (e instanceof ErreurMetier) throw e;
      throw new ErreurMetier('AUCUNE_MISSION', (e as Error).message, 409);
    }
  });

  // ---------------------------------------------------------------- pont matériel
  app.post('/api/materiel/battement', async (req) => {
    const b = z.object({ pont: z.string().trim().min(1).max(60), nature: z.enum(['REEL', 'TEST']) }).parse(req.body);
    materiel().battement(b.pont, b.nature);
    return source.etat();
  });
  app.post('/api/materiel/telemetrie', async (req) => {
    const b = point.extend({ mission_id: z.number().int().nullable().optional(), conteneur_porte_id: z.number().int().nullable().optional(), etape: z.string().max(60).optional() }).parse(req.body);
    materiel().telemetrie(b);
    return { ok: true };
  });

  // ---------------------------------------------------------------- flux temps réel
  app.get('/api/flux', (req, reply: FastifyReply) => {
    const q = z.object({ depuis: z.coerce.number().int().optional() }).parse(req.query);
    reply.hijack();
    diffuseur.ajouterClient(req.raw, reply.raw, q.depuis ?? null);
  });

  // ---------------------------------------------------------------- interface (build Vite)
  const dist = path.join(RACINE, 'dist', 'client');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/' });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send('<meta charset="utf-8"><p>Interface non construite : lancez <code>npm run build</code> (ou <code>npm run dev</code>).</p>'),
    );
  }
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Source-Mode', sourceAction());
  });
  return app;
}
