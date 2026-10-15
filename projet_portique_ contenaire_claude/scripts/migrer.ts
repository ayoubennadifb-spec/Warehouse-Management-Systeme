/** Applique les migrations SQL en attente (db/migrations/*.sql, dans l'ordre). */
import { configServeur, urlSansSecret } from '../src/server/config.ts';
import { creerPool, migrer } from '../src/server/db.ts';

const url = process.argv.includes('--test') ? (configServeur(), process.env.DATABASE_URL_TEST!) : configServeur().databaseUrl;
console.log(`Base : ${urlSansSecret(url)}`);
const pool = creerPool(url);
try {
  const a = await migrer(pool);
  console.log(a.length ? `${a.length} migration(s) appliquée(s).` : 'Schéma déjà à jour.');
} catch (e) {
  console.error('✖', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
