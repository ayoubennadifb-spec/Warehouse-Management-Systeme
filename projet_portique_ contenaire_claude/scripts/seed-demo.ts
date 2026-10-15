/** Charge le plan initial (config/maquette.defaut.json) et le jeu de DÉMONSTRATION. */
import { configServeur, urlSansSecret } from '../src/server/config.ts';
import { creerPool } from '../src/server/db.ts';
import { semerDemo } from '../src/server/demo.ts';

const { databaseUrl } = configServeur();
console.log(`Base : ${urlSansSecret(databaseUrl)}`);
const pool = creerPool(databaseUrl);
try {
  const r = await semerDemo(pool);
  console.log(`✔ Plan initial activé et ${r.conteneurs} conteneurs de démonstration chargés.`);
} catch (e) {
  console.error('✖', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
