/**
 * État côté navigateur : copie de l'état serveur (jamais modifiée localement) + état d'interface.
 * Toute modification passe par l'API ; l'état est rechargé après chaque événement.
 */
import { api } from './api.ts';
import type { Destinations, Etat, EtatBase, EtatSource, ModeScene, Selection, Telemetrie } from './types.ts';

export type EtatFlux = 'connexion' | 'connecte' | 'reconnexion' | 'perdu';

export interface Store {
  etat: Etat | null;
  telemetrie: Telemetrie | null;
  flux: EtatFlux;
  dernierMessage: number;
  derniereSynchro: number;
  base: EtatBase | null;
  source: EtatSource | null;
  erreurChargement: string | null;
  selection: Selection;
  mode: ModeScene;
  destinations: Destinations | null;
  onglet: string;
  vue: '3d' | '2d' | 'deux';
  cotes: boolean;
  message: { type: 'ok' | 'erreur' | 'info'; texte: string; t: number } | null;
}

export const store: Store = {
  etat: null,
  telemetrie: null,
  flux: 'connexion',
  dernierMessage: 0,
  derniereSynchro: 0,
  base: null,
  source: null,
  erreurChargement: null,
  selection: null,
  mode: { type: 'normal' },
  destinations: null,
  onglet: 'selection',
  vue: 'deux',
  cotes: true,
  message: null,
};

type Abonne = (raison: string) => void;
const abonnes = new Set<Abonne>();
export function abonner(f: Abonne): void {
  abonnes.add(f);
}
export function notifier(raison: string): void {
  for (const f of abonnes) f(raison);
}

let rechargementPrevu: number | null = null;
let enCours: Promise<void> | null = null;

/** Recharge l'instantané complet depuis l'API (après événement, reconnexion ou commande). */
export async function recharger(): Promise<void> {
  if (enCours) {
    await enCours;
  }
  enCours = (async () => {
    try {
      const e = await api.get<Etat>('/api/etat');
      store.etat = e;
      store.base = e.base;
      store.source = e.source;
      store.erreurChargement = null;
      store.derniereSynchro = Date.now();
      verifierSelection();
      if (store.mode.type === 'destination' || store.mode.type === 'declaration') await chargerDestinations(store.mode.conteneurId);
    } catch (err) {
      store.erreurChargement = (err as Error).message;
    }
    notifier('etat');
  })();
  try {
    await enCours;
  } finally {
    enCours = null;
  }
}

export function rechargerBientot(delai = 120): void {
  if (rechargementPrevu !== null) return;
  rechargementPrevu = window.setTimeout(() => {
    rechargementPrevu = null;
    void recharger();
  }, delai);
}

export async function chargerDestinations(conteneurId: number): Promise<void> {
  try {
    store.destinations = await api.get<Destinations>(`/api/conteneurs/${conteneurId}/destinations`);
  } catch (e) {
    store.destinations = null;
    afficherMessage('erreur', (e as Error).message);
  }
}

/** La sélection désigne-t-elle encore quelque chose d'existant ? */
function verifierSelection(): void {
  const e = store.etat;
  const s = store.selection;
  if (!e || !s) return;
  if (s.type === 'visite' && !e.visites.some((v) => v.id === s.id)) store.selection = null;
  if (s.type === 'position' && !e.plan?.geometrie.positions.some((p) => p.id === s.id)) store.selection = null;
  if (store.mode.type === 'source_pour_camion' && !e.visites.some((v) => v.plateau_emplacement_id === (store.mode as { plateauId: number }).plateauId))
    store.mode = { type: 'normal' };
}

export function selectionner(s: Selection): void {
  store.selection = s;
  if (store.mode.type === 'destination' || store.mode.type === 'declaration') {
    store.mode = { type: 'normal' };
    store.destinations = null;
  }
  store.onglet = 'selection';
  notifier('selection');
}

export function changerMode(m: ModeScene): void {
  store.mode = m;
  if (m.type === 'normal') store.destinations = null;
  notifier('mode');
}

let minuterieMessage: number | null = null;
export function afficherMessage(type: 'ok' | 'erreur' | 'info', texte: string): void {
  store.message = { type, texte, t: Date.now() };
  notifier('message');
  if (minuterieMessage) clearTimeout(minuterieMessage);
  minuterieMessage = window.setTimeout(() => {
    store.message = null;
    notifier('message');
  }, type === 'erreur' ? 9000 : 4500);
}

/** Exécute une commande ; affiche le refus expliqué par le serveur. */
export async function commande<T>(f: () => Promise<T>, succes?: string): Promise<T | null> {
  try {
    const r = await f();
    if (succes) afficherMessage('ok', succes);
    await recharger();
    return r;
  } catch (e) {
    afficherMessage('erreur', (e as Error).message);
    await recharger();
    return null;
  }
}
