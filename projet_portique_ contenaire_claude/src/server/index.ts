import { existsSync } from 'node:fs';
/** Point d'entrée du serveur local : PostgreSQL → règles métier → API + SSE → interface. */
import { configServeur, configSimulation, urlSansSecret } from './config.ts';
import { creerPool, migrer } from './db.ts';
import { Diffuseur } from './temps-reel.ts';
import { SimulationSource } from './sources/simulation.ts';
import { SourceMateriel } from './sources/materiel.ts';
import { construireApp } from './app.ts';
import type { SourceEvenements } from './sources/types.ts';

export async function demarrerServeur() {
  const cfg = configServeur();
  const pool = creerPool(cfg.databaseUrl);
  await pool.query('SELECT 1').catch((e) => {
    throw new Error(`Connexion PostgreSQL impossible (${urlSansSecret(cfg.databaseUrl)}) : ${e.message}`);
  });
  await migrer(pool, (m) => console.log(m));
  const diffuseur = new Diffuseur(cfg.databaseUrl, pool);
  await diffuseur.demarrer();
  const source: SourceEvenements = cfg.mode === 'SIMULATION' ? new SimulationSource(pool, diffuseur, configSimulation()) : new SourceMateriel(diffuseur);
  diffuseur.etatSource = () => source.etat();
  await source.demarrer();
  const app = await construireApp({ pool, diffuseur, source, mode: cfg.mode }, { journal: true });
  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`Portique — serveur local prêt : http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  console.log(`  base   : ${urlSansSecret(cfg.databaseUrl)}`);
  console.log(`  source : ${cfg.mode}${cfg.mode === 'SIMULATION' ? ' (confirmations simulées)' : ' (attend un pont matériel)'}`);
  let arrete = false;
  const arreter = async () => {
    if (arrete) return;
    arrete = true;
    await source.arreter();
    await diffuseur.arreter(); // ferme d'abord les flux SSE, sinon app.close() les attendrait indéfiniment
    await app.close();
    await pool.end();
  };
  return { app, arreter };
}

if (import.meta.main) {
  const srv = await demarrerServeur().catch((e) => {
    console.error('✖', e.message);
    process.exit(1);
  });
  if(process.env.PORTIQUE_STOP_FILE){const timer=setInterval(()=>{if(existsSync(process.env.PORTIQUE_STOP_FILE!)){clearInterval(timer);void srv.arreter().then(()=>process.exit(0));}},200);timer.unref();}
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      console.log('\nArrêt du serveur…');
      void srv.arreter().then(() => process.exit(0));
    });
}
