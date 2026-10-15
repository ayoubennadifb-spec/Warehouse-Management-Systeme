/**
 * Connexion temps réel (SSE) avec reprise :
 *  - EventSource se reconnecte seul et renvoie Last-Event-ID (rejeu des événements manqués) ;
 *  - après toute reconnexion, l'état complet est rechargé ;
 *  - sans message depuis DELAI_PERIME, les données sont signalées comme potentiellement anciennes.
 */
import { notifier, recharger, rechargerBientot, store } from './store.ts';
import type { Evenement, Telemetrie } from './types.ts';

const DELAI_PERIME_MS = 12_000;
let source: EventSource | null = null;
let ecouteursEvenement: ((e: Evenement) => void)[] = [];

export function surEvenement(f: (e: Evenement) => void): void {
  ecouteursEvenement.push(f);
}

export function connecterFlux(): void {
  const depuis = store.etat?.dernier_evenement_id;
  source = new EventSource(`/api/flux${depuis !== undefined ? `?depuis=${depuis}` : ''}`);
  let aEuErreur = false;

  source.onopen = () => {
    store.flux = 'connecte';
    store.dernierMessage = Date.now();
    if (aEuErreur) void recharger(); // resynchronisation complète après coupure
    aEuErreur = false;
    notifier('flux');
  };
  source.onerror = () => {
    aEuErreur = true;
    store.flux = Date.now() - store.dernierMessage > DELAI_PERIME_MS ? 'perdu' : 'reconnexion';
    notifier('flux');
  };
  source.addEventListener('evenement', (m) => {
    store.dernierMessage = Date.now();
    const ev = JSON.parse((m as MessageEvent).data) as Evenement;
    for (const f of ecouteursEvenement) f(ev);
    rechargerBientot();
  });
  source.addEventListener('battement', (m) => {
    const d = JSON.parse((m as MessageEvent).data);
    store.dernierMessage = Date.now();
    store.base = d.base;
    store.source = d.source;
    if (store.flux !== 'connecte') store.flux = 'connecte';
    notifier('battement');
  });
  source.addEventListener('telemetrie', (m) => {
    store.dernierMessage = Date.now();
    store.telemetrie = JSON.parse((m as MessageEvent).data) as Telemetrie;
    notifier('telemetrie');
  });
  source.addEventListener('resync', () => void recharger());

  window.setInterval(() => {
    const age = Date.now() - store.dernierMessage;
    if (store.flux === 'connecte' && age > DELAI_PERIME_MS) {
      store.flux = 'perdu';
      notifier('flux');
    }
  }, 1000);
}

export function donneesPerimees(): boolean {
  return store.flux === 'perdu' || store.flux === 'reconnexion' || (store.base !== null && !store.base.ok);
}

export function reinitialiserEcouteurs(): void {
  ecouteursEvenement = [];
}
