/** Panneau « Sélection » : conteneur, pile ou camion sélectionné, et actions associées. */
import { api } from '../api.ts';
import { apercuDegagement, calculerDegagement, choisirDestination, declarer, lancerTransfert, modeDeclaration } from '../actions.ts';
import { changerMode, commande, selectionner, store } from '../store.ts';
import { dateHeure, esc, LIB_ETAT, LIB_STATUT, mm } from '../util.ts';
import type { Raison } from '../types.ts';

interface Detail {
  id: number;
  code: string;
  etat: string;
  demo: boolean;
  type_emplacement: string | null;
  code_emplacement: string | null;
  code_position: string | null;
  niveau: number | null;
  code_camion: string | null;
  code_poste: string | null;
  x_mm: number | null;
  y_mm: number | null;
  z_mm: number | null;
  motif_incertitude: string | null;
  longueur_mm: number;
  largeur_mm: number;
  hauteur_mm: number;
  type_code: string;
  mission_active: { id: number; statut: string; prise_confirmee_le: string | null } | null;
  accessibilite: Raison[];
  historique: { etat: string; debut: string; fin: string | null; emplacement: string | null; x_mm: number | null; y_mm: number | null; z_mm: number | null; mission_id: number | null }[];
}

let cache: { id: number; synchro: number; d: Detail } | null = null;
let chargement: number | null = null;

export function rendreSelection(racine: HTMLElement): void {
  const e = store.etat;
  const s = store.selection;
  const m = store.mode;
  if (!e?.plan) {
    racine.innerHTML = '<p class="vide">Aucun plan actif.</p>';
    return;
  }
  if (m.type === 'source_pour_camion') {
    racine.innerHTML = `<div class="carte mode"><h3>Chargement du camion ${esc(m.camion)}</h3>
      <p>Cliquez sur le conteneur à charger (il doit être au sommet d’une pile).</p>
      <button data-action="annuler-mode" class="secondaire">Annuler</button></div>${s?.type === 'position' ? pile(s.id) : ''}`;
    return;
  }
  if (!s) {
    racine.innerHTML = `<div class="aide">
      <h3>Aucune sélection</h3>
      <p>Cliquez sur un <b>conteneur</b> (vue 3D), une <b>pile</b> (vue du dessus) ou un <b>camion</b> pour consulter sa localisation et agir.</p>
      <ul class="legende">
        <li><i class="pastille c-place"></i>Conteneur en place</li>
        <li><i class="pastille c-transfert"></i>En transfert (porté par l’unité abstraite)</li>
        <li><i class="pastille c-incertain"></i>Position incertaine (dernière position connue)</li>
        <li><i class="pastille c-reserve"></i>Emplacement réservé par une mission</li>
        <li><i class="pastille c-unite"></i>Unité de manutention abstraite (mécanisme non choisi)</li>
      </ul></div>`;
    return;
  }
  if (s.type === 'position') {
    racine.innerHTML = pile(s.id);
    return;
  }
  if (s.type === 'visite') {
    racine.innerHTML = visite(s.id);
    return;
  }
  // Conteneur : détail chargé depuis l'API (historique, accessibilité)
  if (!cache || cache.id !== s.id || cache.synchro !== store.derniereSynchro) {
    if (chargement !== s.id) {
      chargement = s.id;
      const synchro = store.derniereSynchro;
      api
        .get<Detail>(`/api/conteneurs/${s.id}`)
        .then((d) => {
          cache = { id: s.id, synchro, d };
          chargement = null;
          if (store.selection?.type === 'conteneur' && store.selection.id === s.id) rendreSelection(racine);
        })
        .catch(() => {
          chargement = null;
          racine.innerHTML = '<p class="vide">Conteneur introuvable (sorti de la zone ?).</p>';
        });
    }
    if (!cache || cache.id !== s.id) {
      racine.innerHTML = '<p class="vide">Chargement…</p>';
      return;
    }
  }
  racine.innerHTML = conteneur(cache.d);
}

function badgeEtat(etat: string): string {
  return `<span class="badge e-${etat.toLowerCase()}">${esc(LIB_ETAT[etat] ?? etat)}</span>`;
}

function conteneur(d: Detail): string {
  const m = store.mode;
  let loc = '';
  if (d.etat === 'EN_PLACE' && d.type_emplacement === 'CASE')
    loc = `<dl class="grille-dl"><dt>Zone</dt><dd>Stockage</dd><dt>Position</dt><dd>${esc(d.code_position)}</dd><dt>Niveau</dt><dd>${d.niveau}</dd>
      <dt>Emplacement</dt><dd>${esc(d.code_emplacement)}</dd><dt>Centre (x ; y)</dt><dd>${mm(d.x_mm)} ; ${mm(d.y_mm)} mm</dd><dt>Base z</dt><dd>${mm(d.z_mm)} mm</dd></dl>`;
  else if (d.etat === 'EN_PLACE')
    loc = `<dl class="grille-dl"><dt>Zone</dt><dd>Transport</dd><dt>Camion</dt><dd>${esc(d.code_camion)}</dd><dt>Poste</dt><dd>${esc(d.code_poste)}</dd>
      <dt>Centre (x ; y)</dt><dd>${mm(d.x_mm)} ; ${mm(d.y_mm)} mm</dd><dt>Base z</dt><dd>${mm(d.z_mm)} mm (plateau, valeur illustrative)</dd></dl>`;
  else if (d.etat === 'EN_TRANSFERT') loc = `<p>Porté par l’unité de manutention (mission M${d.mission_active?.id ?? '?'}). Position enregistrée : aucune tant que le dépôt n’est pas confirmé.</p>`;
  else if (d.etat === 'INCERTAINE')
    loc = `<div class="avertissement"><b>Position incertaine.</b> ${esc(d.motif_incertitude)}<br>Dernière position connue : (${mm(d.x_mm)} ; ${mm(d.y_mm)} ; z ${mm(d.z_mm)}) mm.</div>`;
  else loc = '<p>Sorti de la zone.</p>';

  let actions = '';
  if (m.type === 'destination' && m.conteneurId === d.id) {
    const choix = m.choix !== null ? store.destinations?.destinations.find((x) => x.emplacement_id === m.choix) : null;
    const nb = store.destinations?.destinations.filter((x) => !x.raisons.length).length ?? 0;
    actions = `<div class="carte mode"><h3>Choisir la destination</h3>
      <p>${nb} destination(s) possible(s), en <span class="txt-ok">vert</span>. Survolez une case grisée pour voir pourquoi elle est refusée.</p>
      ${choix ? `<p class="resume-transfert"><b>${esc(d.code)}</b> : ${esc(d.code_emplacement ?? '')} → <b>${esc(choix.code)}</b></p>
        <p class="note">La demande réserve la destination ; la position enregistrée ne change qu’à la prise puis au dépôt confirmés.</p>` : ''}
      <div class="boutons"><button data-action="calculer" ${choix ? '' : 'disabled'}>Calculer le plan complet</button><button data-action="lancer" ${choix && (store.etat?.mode==='MATERIEL'||apercuDegagement) ? '' : 'disabled'}>Lancer le transfert</button>
      <button data-action="annuler-mode" class="secondaire">Annuler</button></div>${apercuDegagement?resumePlan(apercuDegagement):''}</div>`;
  } else if (m.type === 'declaration' && m.conteneurId === d.id) {
    const choix = m.choix !== null ? store.destinations?.destinations.find((x) => x.emplacement_id === m.choix) : null;
    actions = `<div class="carte mode"><h3>Déclarer la position réelle</h3>
      <p>Constatez où se trouve physiquement ${esc(d.code)}, puis choisissez l’emplacement correspondant (vert) ou « sorti de la zone ».</p>
      ${choix ? `<p class="resume-transfert">Position constatée : <b>${esc(choix.code)}</b></p>` : ''}
      <label class="champ">Commentaire (facultatif)<input id="commentaire-decl" maxlength="300" placeholder="ex. constaté visuellement"></label>
      <div class="boutons"><button data-action="declarer" ${choix ? '' : 'disabled'}>Enregistrer cette position</button>
      <button data-action="declarer-sorti" class="secondaire">Sorti de la zone</button>
      <button data-action="annuler-mode" class="secondaire">Annuler</button></div></div>`;
  } else if (d.etat === 'INCERTAINE') {
    actions = `<div class="boutons"><button data-action="mode-declaration" data-id="${d.id}">Déclarer la position réelle…</button></div>`;
  } else if (d.etat === 'EN_PLACE') {
    const refus = d.accessibilite.filter(r=>r.code!=='PAS_AU_SOMMET'||store.etat?.mode==='MATERIEL').map((r) => r.message).join(' ');
    actions = `<div class="boutons"><button data-action="choisir-destination" data-id="${d.id}" ${refus ? 'disabled' : ''}>Choisir une destination…</button></div>
      ${refus ? `<p class="refus">Transfert impossible : ${esc(refus)}</p>` : '<p class="note ok">Le plan déplace les conteneurs supérieurs si nécessaire, puis transporte la cible.</p>'}`;
  }
  const hist = d.historique
    .map(
      (h) => `<li><span class="h-date">${dateHeure(h.debut)}</span> ${badgeEtat(h.etat)} ${esc(h.emplacement ?? (h.mission_id ? `mission M${h.mission_id}` : ''))}
      ${h.x_mm !== null ? `<span class="h-coord">(${mm(h.x_mm)} ; ${mm(h.y_mm)} ; ${mm(h.z_mm)})</span>` : ''}</li>`,
    )
    .join('');
  return `<div class="entete-sel"><h3>${esc(d.code)}</h3>${badgeEtat(d.etat)}${d.demo ? '<span class="badge demo">démo</span>' : ''}</div>
    <p class="note">${esc(d.type_code)} — ${mm(d.longueur_mm)} × ${mm(d.largeur_mm)} × ${mm(d.hauteur_mm)} mm</p>
    ${loc}
    ${d.mission_active ? `<p>Mission active : <b>M${d.mission_active.id}</b> (${esc(LIB_STATUT[d.mission_active.statut] ?? d.mission_active.statut)})</p>` : ''}
    ${actions}
    <h4>Historique des localisations</h4><ul class="historique-loc">${hist || '<li>—</li>'}</ul>`;
}

function pile(positionId: number): string {
  const e = store.etat!;
  const p = e.plan!.geometrie.positions.find((x) => x.id === positionId);
  if (!p) return '<p class="vide">Position inconnue.</p>';
  const emps = e.plan!.geometrie.emplacements.filter((x) => x.position_sol_id === p.id).sort((a, b) => b.niveau - a.niveau);
  const res = new Map(e.reservations.map((r) => [r.emplacement_id, r]));
  const lignes = emps
    .map((em) => {
      const c = e.conteneurs.find((x) => x.emplacement_id === em.id);
      const r = res.get(em.id);
      return `<tr><td>N${em.niveau}</td><td>${mm(em.z_base_mm)} mm</td>
        <td>${c ? `<button class="lien" data-action="selectionner-conteneur" data-id="${c.id}">${esc(c.code)}</button>` : '<span class="vide">vide</span>'}</td>
        <td>${r ? `<span class="badge e-reserve">réservé M${r.mission_id} (${r.role === 'SOURCE' ? 'source' : 'destination'})</span>` : ''}</td></tr>`;
    })
    .join('');
  const bloquee = p.statut === 'BLOQUEE';
  return `<div class="entete-sel"><h3>Position ${esc(p.code)}</h3>${bloquee ? '<span class="badge e-incertaine">bloquée</span>' : ''}</div>
    <dl class="grille-dl"><dt>Centre (x ; y)</dt><dd>${mm(p.centre_x_mm)} ; ${mm(p.centre_y_mm)} mm</dd><dt>Indices</dt><dd>colonne ${p.ix} (X), rangée ${p.iy} (Y)</dd></dl>
    <table class="tableau"><thead><tr><th>Niveau</th><th>Base z</th><th>Conteneur</th><th></th></tr></thead><tbody>${lignes}</tbody></table>
    <p class="note">Seul le conteneur du sommet peut être pris directement.</p>
    ${bloquee ? `<div class="avertissement">Bloquée : ${esc(p.motif_blocage)}</div><div class="boutons"><button data-action="debloquer" data-id="${p.id}" class="secondaire">Débloquer la position</button></div>`
      : `<label class="champ">Bloquer cette position (vide ≠ utilisable)<input id="motif-blocage" maxlength="200" placeholder="motif, ex. zone encombrée"></label>
         <div class="boutons"><button data-action="bloquer" data-id="${p.id}" class="secondaire">Bloquer</button></div>`}`;
}

function visite(id: number): string {
  const e = store.etat!;
  const v = e.visites.find((x) => x.id === id);
  if (!v) return '<p class="vide">Ce camion est reparti.</p>';
  const cont = e.conteneurs.find((c) => c.emplacement_id === v.plateau_emplacement_id);
  const resa = e.reservations.find((r) => r.emplacement_id === v.plateau_emplacement_id);
  const depart = resa
    ? `<button data-action="depart" data-id="${v.id}" disabled>Départ du camion</button><p class="refus">Départ impossible : camion impliqué dans la mission M${resa.mission_id} (transfert actif).</p>`
    : `<button data-action="depart" data-id="${v.id}">Départ du camion${cont ? ` (avec ${esc(cont.code)})` : ' (vide)'}</button>`;
  return `<div class="entete-sel"><h3>Camion ${esc(v.camion_code)}</h3>${v.demo ? '<span class="badge demo">démo</span>' : ''}</div>
    <dl class="grille-dl"><dt>Poste</dt><dd>${esc(v.poste_code)}</dd><dt>Arrivé à</dt><dd>${dateHeure(v.arrivee_le)}</dd>
    <dt>Plateau (x ; y ; z)</dt><dd>${mm(v.plateau_x_mm)} ; ${mm(v.plateau_y_mm)} ; ${mm(v.plateau_z_mm)} mm</dd>
    <dt>Chargement</dt><dd>${cont ? `<button class="lien" data-action="selectionner-conteneur" data-id="${cont.id}">${esc(cont.code)}</button>` : 'plateau vide'}</dd></dl>
    <p class="note">Cabine ${mm(v.cabine_longueur_mm)} × ${mm(v.cabine_largeur_mm)} mm, plateau ${mm(v.plateau_longueur_mm)} × ${mm(v.plateau_largeur_mm)} mm ; hauteurs illustratives.</p>
    <div class="boutons">
      ${cont && !resa ? `<button data-action="decharger" data-id="${cont.id}">Décharger vers le stockage…</button>` : ''}
      ${!cont && !resa ? `<button data-action="charger" data-plateau="${v.plateau_emplacement_id}" data-camion="${esc(v.camion_code)}">Charger depuis le stockage…</button>` : ''}
      ${depart}
    </div>`;
}

export function brancherSelection(racine: HTMLElement): void {
  racine.addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    const id = Number(b.dataset.id);
    switch (b.dataset.action) {
      case 'choisir-destination':
      case 'decharger':
        await choisirDestination(id);
        break;
      case 'mode-declaration':
        await modeDeclaration(id);
        break;
      case 'calculer':
        await calculerDegagement();break;
      case 'lancer':
        await lancerTransfert();
        break;
      case 'declarer':
        await declarer(false, (racine.querySelector('#commentaire-decl') as HTMLInputElement | null)?.value ?? '');
        break;
      case 'declarer-sorti':
        await declarer(true, (racine.querySelector('#commentaire-decl') as HTMLInputElement | null)?.value ?? '');
        break;
      case 'annuler-mode':
        changerMode({ type: 'normal' });
        break;
      case 'selectionner-conteneur':
        if (store.mode.type === 'source_pour_camion') await choisirDestination(id, store.mode.plateauId);
        else selectionner({ type: 'conteneur', id });
        break;
      case 'bloquer': {
        const motif = (racine.querySelector('#motif-blocage') as HTMLInputElement).value.trim();
        if (!motif) {
          (racine.querySelector('#motif-blocage') as HTMLInputElement).focus();
          return;
        }
        await commande(() => api.post(`/api/positions/${id}/blocage`, { motif }), 'Position bloquée.');
        break;
      }
      case 'debloquer':
        await commande(() => api.post(`/api/positions/${id}/blocage`, { motif: null }), 'Position débloquée.');
        break;
      case 'depart':
        await commande(() => api.post(`/api/visites/${id}/depart`), 'Camion parti.');
        break;
      case 'charger':
        changerMode({ type: 'source_pour_camion', plateauId: Number(b.dataset.plateau), camion: b.dataset.camion ?? '' });
        break;
    }
  });
}

function resumePlan(p:any):string{return `<div class="carte"><h3>Plan complet · ${esc(p.target)}</h3><p>${Math.round(p.totalDistanceMm)} mm : ${Math.round(p.loadedDistanceMm)} mm en charge et ${Math.round(p.emptyDistanceMm)} mm à vide · ${p.estimatedSeconds.toFixed(1)} s estimées à ×1.</p><ol>${p.steps.map((s:any)=>`<li>${esc(s.container)} → ${esc(s.destination.replace('slot:','Position ').replace('truck:','Camion '))} · ${s.estimatedSeconds.toFixed(1)} s</li>`).join('')}</ol><p class="note">${p.optimization==='exhaustive'?'Toutes les affectations admissibles ont été comparées.':'Meilleur plan trouvé par recherche limitée.'} Positions mises à jour après chaque dépôt. Vitesses provisoires X/Y 100 mm/s, Z 50 mm/s ; accélérations 200/100 mm/s² ; prise et dépôt 1 s chacun. Les conteneurs dégagés restent à leurs nouvelles places.</p></div>`;}
