/** Actions de l'opérateur, communes à la vue 3D, à la vue du dessus et aux panneaux. */
import { api } from './api.ts';
import { afficherMessage, changerMode, chargerDestinations, commande, notifier, selectionner, store } from './store.ts';
import type { ActionsVue } from './vue-dessus.ts';

export let apercuDegagement:any=null;
export async function calculerDegagement():Promise<void>{
 const m=store.mode;if(m.type!=='destination'||m.choix===null)return;
 apercuDegagement=null;notifier('destinations');
 apercuDegagement=await commande(()=>api.post('/api/degagement/apercu',{conteneur_id:m.conteneurId,destination_emplacement_id:m.choix}));
 notifier('destinations');
}

export async function choisirDestination(conteneurId: number, preselection: number | null = null): Promise<void> {
  apercuDegagement=null;
  store.selection = { type: 'conteneur', id: conteneurId };
  store.onglet = 'selection';
  changerMode({ type: 'destination', conteneurId, choix: null });
  await chargerDestinations(conteneurId);
  const refus=store.destinations?.source.filter(r=>r.code!=='PAS_AU_SOMMET'||store.etat?.mode==='MATERIEL')??[];
  if (refus.length) {
    afficherMessage('erreur', refus.map((r) => r.message).join(' '));
    changerMode({ type: 'normal' });
    return;
  }
  if (preselection !== null) choisirEmplacement(preselection);
  notifier('destinations');
}

export async function modeDeclaration(conteneurId: number): Promise<void> {
  store.selection = { type: 'conteneur', id: conteneurId };
  store.onglet = 'selection';
  changerMode({ type: 'declaration', conteneurId, choix: null });
  await chargerDestinations(conteneurId);
  notifier('destinations');
}

export function choisirEmplacement(id: number): void {
  const m = store.mode;
  if (m.type !== 'destination' && m.type !== 'declaration') return;
  const d = store.destinations?.destinations.find((x) => x.emplacement_id === id);
  if (!d) return;
  if (d.raisons.length) {
    afficherMessage('erreur', `${d.code} refusé : ${d.raisons.map((r) => r.message).join(' ')}`);
    return;
  }
  apercuDegagement=null;
  changerMode({ ...m, choix: id });
}

export async function lancerTransfert(): Promise<void> {
  const m = store.mode;
  if (m.type !== 'destination' || m.choix === null) return;
  if(store.etat?.mode==='SIMULATION'&&!apercuDegagement){await calculerDegagement();return;}
  const r = await commande(
    () => api.post<{ id: number }>(apercuDegagement?'/api/degagement/lancer':'/api/missions', { conteneur_id: m.conteneurId, destination_emplacement_id: m.choix,...(apercuDegagement?{revision:apercuDegagement.revision}:{}) }),
  );
  if (r) {
    afficherMessage('ok', `Transfert n°${r.id} créé : la position enregistrée changera à la confirmation de prise puis de dépôt.`);
    changerMode({ type: 'normal' });
  }
}

export async function declarer(sorti: boolean, commentaire: string): Promise<void> {
  const m = store.mode;
  const conteneurId = m.type === 'declaration' ? m.conteneurId : null;
  if (conteneurId === null) return;
  if (!sorti && (m.type !== 'declaration' || m.choix === null)) return;
  const r = await commande(
    () =>
      api.post(`/api/conteneurs/${conteneurId}/declarer-position`, {
        emplacement_id: sorti ? null : (m as { choix: number }).choix,
        sorti,
        commentaire: commentaire || null,
      }),
    'Position déclarée et enregistrée.',
  );
  if (r) changerMode({ type: 'normal' });
}

export const actionsVue: ActionsVue = {
  cliquerConteneur(id) {
    const m = store.mode;
    if (m.type === 'source_pour_camion') {
      void choisirDestination(id, m.plateauId);
      return;
    }
    if (m.type === 'destination' || m.type === 'declaration') {
      afficherMessage('info', 'Mode choix de destination : cliquez une case verte, ou « Annuler ».');
      return;
    }
    selectionner({ type: 'conteneur', id });
  },
  cliquerPosition(id) {
    const m = store.mode;
    if (m.type === 'destination' || m.type === 'declaration') {
      afficherMessage('info', 'Cette position ne peut pas recevoir le conteneur (survolez-la pour voir la raison).');
      return;
    }
    if (m.type === 'source_pour_camion') {
      afficherMessage('info', 'Cliquez directement sur un conteneur au sommet d’une pile (vue 3D) ou choisissez-le dans la pile ci-contre.');
      selectionner({ type: 'position', id });
      store.mode = m;
      return;
    }
    selectionner({ type: 'position', id });
  },
  cliquerVisite(id) {
    if (store.mode.type === 'destination' || store.mode.type === 'declaration') {
      afficherMessage('info', 'Ce plateau ne peut pas recevoir le conteneur (survolez-le pour voir la raison).');
      return;
    }
    selectionner({ type: 'visite', id });
  },
  cliquerEmplacement(id) {
    choisirEmplacement(id);
  },
};
