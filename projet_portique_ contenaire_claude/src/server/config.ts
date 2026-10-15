import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ParametresMaquette } from '../shared/geometrie.ts';

export const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Charge .env (s'il existe) sans écraser les variables déjà définies. */
export function chargerEnv(): void {
  const f = path.join(RACINE, '.env');
  if (existsSync(f)) process.loadEnvFile(f);
}

export type ModeSource = 'SIMULATION' | 'MATERIEL';

export interface ConfigServeur {
  databaseUrl: string;
  port: number;
  host: string;
  mode: ModeSource;
}

export function configServeur(): ConfigServeur {
  chargerEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL manquant : copiez .env.example en .env ou lancez « npm run db:init ».');
  }
  const mode = (process.env.SOURCE_EVENEMENTS ?? 'SIMULATION').toUpperCase();
  if (mode !== 'SIMULATION' && mode !== 'MATERIEL') throw new Error(`SOURCE_EVENEMENTS invalide : ${mode}`);
  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
    mode,
  };
}

export interface ConfigSimulation {
  degagement_mm: number;
  vitesse_xy_mm_s: number;
  vitesse_z_mm_s: number;
  duree_prise_s: number;
  duree_depot_s: number;
  position_repos: { x_mm: number; y_mm: number };
  periode_tick_ms: number;
  frequence_telemetrie_hz: number;
}

export function configSimulation(): ConfigSimulation {
  return JSON.parse(readFileSync(path.join(RACINE, 'config', 'simulation.json'), 'utf8'));
}

export function parametresParDefaut(): ParametresMaquette {
  return JSON.parse(readFileSync(path.join(RACINE, 'config', 'maquette.defaut.json'), 'utf8'));
}

/** Masque le mot de passe d'une URL de connexion (pour l'affichage). */
export function urlSansSecret(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(URL invalide)';
  }
}
