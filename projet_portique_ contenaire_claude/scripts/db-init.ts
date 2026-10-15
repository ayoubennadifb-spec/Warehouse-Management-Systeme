/**
 * Crée (si besoin) le rôle applicatif et les bases `portique` et `portique_test`
 * sur le PostgreSQL LOCAL, puis écrit .env (jamais versionné).
 *
 *   npm run db:init
 *
 * Le mot de passe du super-utilisateur (postgres) est demandé de façon masquée
 * et n'est enregistré nulle part. Non interactif possible : variable PGADMIN_URL
 * (ex. postgres://postgres:motdepasse@localhost:5432/postgres).
 */
import pg from 'pg';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { RACINE } from '../src/server/config.ts';

const fichierEnv = path.join(RACINE, '.env');

function question(texte: string, masque = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (masque) {
      const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      rlAny._writeToOutput = (s: string) => {
        if (s.startsWith(texte)) rlAny.output.write(texte);
        else if (s.includes('\n') || s.includes('\r')) rlAny.output.write('\n');
      };
    }
    rl.question(texte, (r) => {
      rl.close();
      resolve(r);
    });
  });
}

function lireEnv(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(fichierEnv)) return m;
  for (const ligne of readFileSync(fichierEnv, 'utf8').split(/\r?\n/)) {
    const i = ligne.indexOf('=');
    if (i > 0 && !ligne.trimStart().startsWith('#')) m.set(ligne.slice(0, i).trim(), ligne.slice(i + 1).trim());
  }
  return m;
}

function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Identifiant SQL refusé : ${s}`);
  return s;
}

async function main(): Promise<void> {
  let adminUrl = process.env.PGADMIN_URL;
  if (!adminUrl) {
    console.log('Connexion administrateur au PostgreSQL local (utilisée une seule fois, rien n’est enregistré).');
    const hote = (await question('Hôte [localhost] : ')) || 'localhost';
    const port = (await question('Port [5432] : ')) || '5432';
    const user = (await question('Utilisateur administrateur [postgres] : ')) || 'postgres';
    const mdp = await question('Mot de passe administrateur : ', true);
    adminUrl = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(mdp)}@${hote}:${port}/postgres`;
  }
  const admin = new URL(adminUrl);

  const env = lireEnv();
  let appUrl: URL;
  if (env.get('DATABASE_URL') && !env.get('DATABASE_URL')!.includes('CHANGER_MOI')) {
    appUrl = new URL(env.get('DATABASE_URL')!);
    console.log('.env existant : réutilisation du rôle et du mot de passe qu’il contient.');
  } else {
    appUrl = new URL(`postgres://portique_app@${admin.hostname}:${admin.port || 5432}/portique`);
    appUrl.password = randomBytes(18).toString('base64url');
  }
  const role = ident(decodeURIComponent(appUrl.username));
  const base = ident(appUrl.pathname.replace(/^\//, ''));
  const baseTest = ident(env.get('DATABASE_URL_TEST') ? new URL(env.get('DATABASE_URL_TEST')!).pathname.slice(1) : `${base}_test`);
  const mdpApp = decodeURIComponent(appUrl.password);

  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const existe = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    const lit = (await c.query('SELECT quote_literal($1) AS q', [mdpApp])).rows[0].q;
    if (existe.rowCount) {
      await c.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${lit}`);
      console.log(`✔ rôle ${role} existant : mot de passe synchronisé avec .env`);
    } else {
      await c.query(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${lit}`);
      console.log(`✔ rôle ${role} créé`);
    }
    for (const b of [base, baseTest]) {
      const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [b]);
      if (r.rowCount) console.log(`• base ${b} déjà présente`);
      else {
        await c.query(`CREATE DATABASE ${b} OWNER ${role} ENCODING 'UTF8' TEMPLATE template0`);
        console.log(`✔ base ${b} créée (propriétaire ${role}, UTF8)`);
      }
    }
  } finally {
    await c.end();
  }
  // Le rôle doit pouvoir créer dans le schéma public de ses bases (PostgreSQL 15+ le restreint)
  for (const b of [base, baseTest]) {
    const u = new URL(adminUrl);
    u.pathname = `/${b}`;
    const cb = new pg.Client({ connectionString: u.toString() });
    await cb.connect();
    await cb.query(`ALTER SCHEMA public OWNER TO ${role}`).catch(() => undefined);
    await cb.end();
  }

  if (!existsSync(fichierEnv) || !env.get('DATABASE_URL') || env.get('DATABASE_URL')!.includes('CHANGER_MOI')) {
    const test = new URL(appUrl.toString());
    test.pathname = `/${baseTest}`;
    const modele = readFileSync(path.join(RACINE, '.env.example'), 'utf8')
      .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${appUrl.toString()}`)
      .replace(/^DATABASE_URL_TEST=.*$/m, `DATABASE_URL_TEST=${test.toString()}`);
    writeFileSync(fichierEnv, modele, 'utf8');
    console.log('✔ fichier .env écrit (contient le mot de passe du rôle applicatif ; ne pas le partager).');
  }
  console.log('\nÉtapes suivantes :  npm run db:migrate   puis   npm run db:seed');
}

main().catch((e) => {
  console.error('✖', e.message);
  process.exit(1);
});
