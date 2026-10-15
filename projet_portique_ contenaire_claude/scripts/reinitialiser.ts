/**
 * EFFACE toute la base (schéma public), réapplique les migrations et recharge la démonstration.
 *   npm run db:reset -- --oui
 */
import { configServeur, urlSansSecret } from '../src/server/config.ts';
import { creerPool, migrer, viderSchema } from '../src/server/db.ts';
import { semerDemo } from '../src/server/demo.ts';

const { databaseUrl } = configServeur();
if (!process.argv.includes('--oui')) {
  console.error(`Cette commande EFFACE toutes les données de ${urlSansSecret(databaseUrl)} (historique compris).`);
  console.error('Relancez avec :  npm run db:reset -- --oui');
  process.exit(1);
}
const pool = creerPool(databaseUrl);
try {
  await viderSchema(pool);
  await migrer(pool);
  if (process.argv.includes('--sans-demo')) {
    await semerDemo(pool, { planSeulement: true });
    console.log('✔ Base réinitialisée : plan initial actif, aucun conteneur (inventaire réel à saisir).');
  } else {
    const r = await semerDemo(pool);
    console.log(`✔ Base réinitialisée : ${r.conteneurs} conteneurs de démonstration.`);
  }
} catch (e) {
  console.error('✖', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
