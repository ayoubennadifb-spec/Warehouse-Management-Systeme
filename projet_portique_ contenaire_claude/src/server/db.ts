import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RACINE } from './config.ts';
import { traduireErreurPg } from './erreurs.ts';

// numeric et bigint → number (valeurs en mm et identifiants restent très en deçà de 2^53)
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Client = pg.PoolClient;
export type Requeteur = pg.Pool | pg.PoolClient;

/** Clé du verrou consultatif qui sérialise toutes les écritures métier. */
export const VERROU_PORTIQUE = 7_041_986;

export function creerPool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
  pool.on('error', (e) => console.error('[pg] erreur de connexion inactive :', e.message));
  return pool;
}

/**
 * Exécute fn dans une transaction protégée par un verrou consultatif global :
 * deux demandes simultanées sont traitées l'une après l'autre ; les contraintes
 * différées sont vérifiées au COMMIT et traduites en erreurs métier.
 */
export async function transaction<T>(pool: pg.Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [VERROU_PORTIQUE]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw traduireErreurPg(e);
  } finally {
    c.release();
  }
}

export async function une<T = any>(q: Requeteur, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function toutes<T = any>(q: Requeteur, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(sql, params);
  return r.rows as T[];
}

// ---------------------------------------------------------------- migrations
const DOSSIER_MIGRATIONS = path.join(RACINE, 'db', 'migrations');

export async function migrer(pool: pg.Pool, log: (m: string) => void = console.log): Promise<string[]> {
  const appliquees: string[] = [];
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, somme_controle text NOT NULL, appliquee_le timestamptz NOT NULL DEFAULT now())`);
    await c.query('SELECT pg_advisory_lock($1)', [VERROU_PORTIQUE + 1]);
    const deja = new Map(
      (await c.query('SELECT version, somme_controle FROM schema_migrations')).rows.map((r) => [r.version, r.somme_controle]),
    );
    const fichiers = readdirSync(DOSSIER_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const f of fichiers) {
      const sql = readFileSync(path.join(DOSSIER_MIGRATIONS, f), 'utf8');
      const somme = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      if (deja.has(f)) {
        if (deja.get(f) !== somme) log(`⚠ ${f} a été modifiée après application (somme de contrôle différente). Créez plutôt une nouvelle migration.`);
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (version, somme_controle) VALUES ($1, $2)', [f, somme]);
        await c.query('COMMIT');
        appliquees.push(f);
        log(`✔ migration appliquée : ${f}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Échec de la migration ${f} : ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [VERROU_PORTIQUE + 1]).catch(() => undefined);
    c.release();
  }
  return appliquees;
}

/** Supprime TOUT le contenu (schéma public) — réservé à db:reset et aux tests. */
export async function viderSchema(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
