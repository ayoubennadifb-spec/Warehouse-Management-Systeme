/** Panneau « Missions » : file active avec avancement, actions, puis historique. */
import { api } from '../api.ts';
import { modeDeclaration } from '../actions.ts';
import { commande, selectionner, store } from '../store.ts';
import { duree, esc, heure, LIB_STATUT, LIB_TYPE_MISSION } from '../util.ts';
import type { Mission } from '../types.ts';

const ACTIFS = ['EN_ATTENTE', 'EN_COURS', 'SUSPENDUE', 'INTERROMPUE'];

function etapes(m: Mission): string {
  const t = store.telemetrie;
  const live = t && t.mission_id === m.id;
  const items = [
    ['Demande', true],
    ['Démarrage', !!m.demarree_le],
    ['Prise confirmée', !!m.prise_confirmee_le],
    ['Dépôt confirmé', !!m.depot_confirme_le],
  ] as const;
  const prog = live && t.progression !== null ? Math.round(t.progression * 100) : m.depot_confirme_le ? 100 : m.prise_confirmee_le ? 55 : m.demarree_le ? 10 : 0;
  return `<ol class="etapes">${items.map(([l, ok]) => `<li class="${ok ? 'fait' : ''}">${l}</li>`).join('')}</ol>
    <div class="barre" role="progressbar" aria-valuenow="${prog}" aria-valuemin="0" aria-valuemax="100"><span style="width:${prog}%"></span></div>
    ${live ? `<p class="note">Étape simulée : ${esc(t.etape)}${t.en_pause ? ' — en pause' : ''}</p>` : ''}`;
}

function boutons(m: Mission): string {
  const b: string[] = [];
  const btn = (a: string, l: string, cls = 'secondaire') => `<button class="${cls}" data-action="${a}" data-id="${m.id}">${l}</button>`;
  if (m.statut === 'EN_COURS') b.push(btn('suspendre', 'Suspendre'), btn('interrompre', 'Interrompre', 'danger'));
  if (m.statut === 'SUSPENDUE') b.push(btn('reprendre', 'Reprendre', ''));
  if (m.statut === 'INTERROMPUE') {
    if (m.prise_confirmee_le) {
      b.push(btn('reprendre-tenu', 'Reprendre (conteneur toujours tenu)', ''));
      b.push(`<button class="secondaire" data-action="declarer" data-id="${m.conteneur_id}">Déclarer la position</button>`);
    } else b.push(btn('reprendre', 'Reprendre', ''));
  }
  if (ACTIFS.includes(m.statut)) b.push(btn('annuler', 'Annuler'));
  return `<div class="boutons">${b.join('')}</div>`;
}

export function rendreMissions(racine: HTMLElement): void {
  const e = store.etat;
  if (!e) return;
  const actives = e.missions.filter((m) => ACTIFS.includes(m.statut)).sort((a, b) => a.id - b.id);
  const fini = e.missions.filter((m) => !ACTIFS.includes(m.statut));
  const src = store.source;
  racine.innerHTML = `
    ${src?.bloque ? `<div class="avertissement">${esc(src.bloque)}</div>` : ''}
    <p class="note">Trajets de simulation optimisés avec les piles et cabines connues. Profil de vitesse et d’accélération provisoire ; aucune commande physique.</p>
    ${e.operation?`<article class="carte"><h3>Plan complet · ${esc(e.operation.plan.target)}</h3><p>${esc(e.operation.statut==='TERMINEE'?'Terminé':e.operation.statut==='EN_COURS'?'En cours':'Arrêté')} · ${Math.round(e.operation.plan.totalDistanceMm)} mm au total · ${e.operation.plan.estimatedSeconds.toFixed(1)} s estimées à ×1</p><ol>${e.operation.plan.steps.map((step:any,i:number)=>`<li>${i<e.operation!.indice?'✓ ':''}${esc(step.container)} → ${esc(step.destination.replace('slot:','Position ').replace('truck:','Camion '))}</li>`).join('')}</ol><p class="note">Les nouvelles positions sont enregistrées après chaque dépôt.</p></article>`:''}
    <h4>Missions actives (${actives.length})</h4>
    ${
      actives.length
        ? actives
            .map(
              (m) => `<article class="carte mission s-${m.statut.toLowerCase()}">
          <header><b>M${m.id}</b> <span class="badge s-${m.statut.toLowerCase()}">${esc(LIB_STATUT[m.statut])}</span>
          <button class="lien" data-action="voir" data-id="${m.conteneur_id}">${esc(m.conteneur_code)}</button></header>
          <p>${esc(LIB_TYPE_MISSION[m.type] ?? m.type)} : <b>${esc(m.source_code)}</b> → <b>${esc(m.destination_code)}</b></p>
          ${m.motif_fin ? `<p class="refus">${esc(m.motif_fin)}</p>` : ''}
          ${etapes(m)}${boutons(m)}</article>`,
            )
            .join('')
        : '<p class="vide">Aucune mission active. Sélectionnez un conteneur puis « Choisir une destination ».</p>'
    }
    <h4>Historique</h4>
    <table class="tableau compact"><thead><tr><th>N°</th><th>Conteneur</th><th>Trajet</th><th>Statut</th><th>Fin</th><th>Durée</th></tr></thead>
    <tbody>${
      fini
        .map(
          (m) => `<tr title="${esc(m.motif_fin ?? '')}"><td>M${m.id}</td><td>${esc(m.conteneur_code)}</td><td>${esc(m.source_code)} → ${esc(m.destination_code)}</td>
          <td><span class="badge s-${m.statut.toLowerCase()}">${esc(LIB_STATUT[m.statut])}</span></td><td>${heure(m.terminee_le)}</td><td>${duree(m.demarree_le, m.terminee_le)}</td></tr>`,
        )
        .join('') || '<tr><td colspan="6" class="vide">—</td></tr>'
    }</tbody></table>`;
}

export function brancherMissions(racine: HTMLElement): void {
  racine.addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!b) return;
    const id = Number(b.dataset.id);
    switch (b.dataset.action) {
      case 'suspendre':
        await commande(() => api.post(`/api/missions/${id}/suspendre`), `M${id} suspendue.`);
        break;
      case 'reprendre':
        await commande(() => api.post(`/api/missions/${id}/reprendre`, {}), `M${id} reprise.`);
        break;
      case 'reprendre-tenu':
        await commande(() => api.post(`/api/missions/${id}/reprendre`, { conteneur_toujours_tenu: true }), `M${id} reprise.`);
        break;
      case 'interrompre':
        await commande(() => api.post(`/api/missions/${id}/interrompre`, { motif: 'Interruption demandée par l’opérateur' }), `M${id} interrompue.`);
        break;
      case 'annuler':
        await commande(() => api.post(`/api/missions/${id}/annuler`, { motif: 'Annulation opérateur' }), `M${id} annulée.`);
        break;
      case 'declarer':
        await modeDeclaration(id);
        break;
      case 'voir':
        selectionner({ type: 'conteneur', id });
        break;
    }
  });
}
