/** Échappement HTML (toutes les données affichées passent par ici). */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const mm = (v: number | null | undefined, d = 1): string =>
  v === null || v === undefined ? '—' : `${Number(v).toLocaleString('fr-FR', { maximumFractionDigits: d })}`;

export function heure(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateHeure(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duree(debut: string | null, fin: string | null): string {
  if (!debut || !fin) return '—';
  const s = (new Date(fin).getTime() - new Date(debut).getTime()) / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export const LIB_ETAT: Record<string, string> = {
  EN_PLACE: 'En place',
  EN_TRANSFERT: 'En transfert',
  INCERTAINE: 'Position incertaine',
  SORTI: 'Sorti de la zone',
};

export const LIB_STATUT: Record<string, string> = {
  EN_ATTENTE: 'En attente',
  EN_COURS: 'En cours',
  SUSPENDUE: 'Suspendue',
  INTERROMPUE: 'Interrompue',
  TERMINEE: 'Terminée',
  ANNULEE: 'Annulée',
};

export const LIB_TYPE_MISSION: Record<string, string> = {
  STOCKAGE_VERS_STOCKAGE: 'Stockage → stockage',
  CAMION_VERS_STOCKAGE: 'Déchargement camion → stockage',
  STOCKAGE_VERS_CAMION: 'Chargement stockage → camion',
  CAMION_VERS_CAMION: 'Camion → camion',
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export function $(sel: string, racine: ParentNode = document): HTMLElement {
  const e = racine.querySelector(sel);
  if (!e) throw new Error(`élément introuvable : ${sel}`);
  return e as HTMLElement;
}
