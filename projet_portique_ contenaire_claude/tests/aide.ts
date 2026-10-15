/** Outils communs des tests d'intégration (base DATABASE_URL_TEST, vidée à chaque suite). */
import type pg from 'pg';
import { chargerEnv } from '../src/server/config.ts';
import { creerPool, migrer, transaction, une, viderSchema, type Client } from '../src/server/db.ts';
import { semerDemo } from '../src/server/demo.ts';

export async function nouvelleBase(demo = true): Promise<pg.Pool> {
  chargerEnv();
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST manquant dans .env');
  if (url === process.env.DATABASE_URL) throw new Error('DATABASE_URL_TEST doit désigner une base distincte (elle est effacée).');
  const pool = creerPool(url);
  await viderSchema(pool);
  await migrer(pool, () => undefined);
  if (demo) await semerDemo(pool);
  return pool;
}

export const tx = <T>(pool: pg.Pool, fn: (c: Client) => Promise<T>) => transaction(pool, fn);

/** id d'un emplacement CASE du plan actif par son code (ex. « A1-N1 ») ou du plateau d'un camion. */
export async function emp(pool: pg.Pool, code: string): Promise<number> {
  const r = await une(
    pool,
    `SELECT e.id FROM emplacement e LEFT JOIN version_plan v ON v.id = e.version_plan_id
      WHERE e.code = $1 AND (e.type = 'PLATEAU' OR v.statut = 'ACTIVE')`,
    [code],
  );
  if (!r) throw new Error(`emplacement ${code} introuvable`);
  return r.id;
}

export async function cont(pool: pg.Pool, code: string): Promise<any> {
  return une(pool, `SELECT * FROM v_conteneur_localisation WHERE code = $1`, [code]);
}

/** Pile d'une position : codes des conteneurs du niveau 1 au sommet. */
export async function pile(pool: pg.Pool, position: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT c.code FROM conteneur c JOIN emplacement e ON e.id = c.emplacement_id JOIN position_sol p ON p.id = e.position_sol_id
       JOIN version_plan v ON v.id = p.version_plan_id AND v.statut = 'ACTIVE' WHERE p.code = $1 ORDER BY e.niveau`,
    [position],
  );
  return r.rows.map((x) => x.code);
}

/** Première position (ordre des codes) ayant exactement h conteneurs. */
export async function positionDeHauteur(pool: pg.Pool, h: number, sauf: string[] = []): Promise<string> {
  const r = await pool.query(
    `SELECT p.code, count(c.id) AS n FROM position_sol p JOIN version_plan v ON v.id = p.version_plan_id AND v.statut = 'ACTIVE'
       JOIN emplacement e ON e.position_sol_id = p.id LEFT JOIN conteneur c ON c.emplacement_id = e.id
      GROUP BY p.code, p.ix, p.iy HAVING count(c.id) = $1 ORDER BY p.ix, p.iy`,
    [h],
  );
  const p = r.rows.find((x) => !sauf.includes(x.code));
  if (!p) throw new Error(`aucune position de hauteur ${h}`);
  return p.code;
}
