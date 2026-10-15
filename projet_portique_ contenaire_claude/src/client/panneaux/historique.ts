/** Panneau « Historique » : journal des événements (append-only), filtrable, avec pagination. */
import { api } from '../api.ts';
import { store } from '../store.ts';
import { dateHeure, esc } from '../util.ts';
import type { Evenement } from '../types.ts';

let anciens: Evenement[] = [];
let filtre = 'tous';
let racineH: HTMLElement | null = null;

const FILTRES: Record<string, (e: Evenement) => boolean> = {
  tous: () => true,
  missions: (e) => /MISSION|PRISE|DEPOT|CONFIRMATION/.test(e.type),
  camions: (e) => /CAMION|ARRIVEE|POSTE/.test(e.type),
  plan: (e) => /PLAN|POSITION_BLOQ|POSITION_DEBLOQ|INVENTAIRE/.test(e.type),
  alertes: (e) => e.gravite !== 'INFO',
};

export function rendreHistorique(racine: HTMLElement): void {
  racineH = racine;
  const e = store.etat;
  if (!e) return;
  const vus = new Set<number>();
  const tous = [...e.evenements, ...anciens].filter((x) => (vus.has(x.id) ? false : (vus.add(x.id), true))).sort((a, b) => b.id - a.id);
  const liste = tous.filter(FILTRES[filtre]);
  racine.innerHTML = `<div class="ligne-champs">
      <label class="champ">Filtrer<select id="filtre-hist">
        ${Object.keys(FILTRES).map((k) => `<option value="${k}" ${k === filtre ? 'selected' : ''}>${{ tous: 'Tous les événements', missions: 'Missions et confirmations', camions: 'Camions et postes', plan: 'Plan et positions', alertes: 'Avertissements et alertes' }[k]}</option>`).join('')}
      </select></label></div>
    <p class="note">Journal en ajout seul (PostgreSQL). Chaque événement a un identifiant stable, un horodatage serveur et sa source.</p>
    <ol class="journal">${liste
      .map(
        (x) => `<li class="g-${x.gravite.toLowerCase()}"><div class="j-tete"><span class="j-id">#${x.id}</span><time>${dateHeure(x.horodatage)}</time>
        <span class="badge src-${x.source.toLowerCase()}">${esc(x.source)}</span><span class="j-type">${esc(x.type)}</span></div>
        <div class="j-msg">${esc(x.message)}</div></li>`,
      )
      .join('')}</ol>
    <div class="boutons"><button class="secondaire" id="plus-hist">Charger des événements plus anciens</button></div>`;
}

export function brancherHistorique(racine: HTMLElement): void {
  racine.addEventListener('change', (ev) => {
    const t = ev.target as HTMLSelectElement;
    if (t.id === 'filtre-hist') {
      filtre = t.value;
      rendreHistorique(racine);
    }
  });
  racine.addEventListener('click', async (ev) => {
    if ((ev.target as HTMLElement).id !== 'plus-hist') return;
    const ids = [...(store.etat?.evenements ?? []), ...anciens].map((x) => x.id);
    const min = ids.length ? Math.min(...ids) : undefined;
    const r = await api.get<Evenement[]>(`/api/evenements?limite=100${min ? `&avant=${min}` : ''}`);
    anciens = [...anciens, ...r];
    if (racineH) rendreHistorique(racineH);
  });
}
