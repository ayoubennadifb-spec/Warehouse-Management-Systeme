/** Panneau « Camions » : arrivée (vide ou chargé), camions présents, visites récentes. */
import { api, ErreurApi } from '../api.ts';
import { choisirDestination } from '../actions.ts';
import { afficherMessage, changerMode, commande, recharger, selectionner, store } from '../store.ts';
import { esc, heure } from '../util.ts';

let formulaire: HTMLElement | null = null;
let liste: HTMLElement | null = null;
let resultat = '';

function suggestion(prefixe: string, existants: string[]): string {
  for (let i = 1; i < 1000; i++) {
    const c = `${prefixe}${String(i).padStart(2, '0')}`;
    if (!existants.includes(c)) return c;
  }
  return `${prefixe}X`;
}

export function rendreCamions(racine: HTMLElement): void {
  const e = store.etat;
  if (!e?.plan) return;
  if (!formulaire) {
    racine.innerHTML = `<form class="carte" id="form-arrivee" novalidate>
        <h3>Arrivée d’un camion</h3>
        <div class="ligne-champs">
          <label class="champ">Code camion<input name="camion" required maxlength="40"></label>
          <label class="champ">Poste<select name="poste"></select></label>
        </div>
        <label class="coche"><input type="checkbox" name="charge"> Arrive avec un conteneur</label>
        <label class="champ" data-si="charge">Code du conteneur<input name="conteneur" maxlength="40"></label>
        <div class="boutons"><button type="submit">Faire arriver</button></div>
        <div class="resultat-arrivee" aria-live="polite"></div>
      </form><div id="liste-camions"></div>`;
    formulaire = racine.querySelector('#form-arrivee')!;
    liste = racine.querySelector('#liste-camions')!;
    const f = formulaire as HTMLFormElement;
    const majCharge = () => ((f.querySelector('[data-si="charge"]') as HTMLElement).hidden = !(f.elements.namedItem('charge') as HTMLInputElement).checked);
    (f.elements.namedItem('charge') as HTMLInputElement).addEventListener('change', majCharge);
    majCharge();
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ic = f.elements.namedItem('camion') as HTMLInputElement;
      const io = f.elements.namedItem('conteneur') as HTMLInputElement;
      const camion = ic.value.trim() || ic.placeholder;
      const charge = (f.elements.namedItem('charge') as HTMLInputElement).checked;
      const conteneur = io.value.trim() || io.placeholder;
      const poste = (f.elements.namedItem('poste') as HTMLSelectElement).value;
      if (!camion) return (f.elements.namedItem('camion') as HTMLInputElement).focus();
      if (charge && !conteneur) return (f.elements.namedItem('conteneur') as HTMLInputElement).focus();
      try {
        const r = await api.post<{ poste_code: string }>('/api/camions/arrivee', { camion_code: camion, conteneur_code: charge ? conteneur : null, poste_code: poste || null });
        resultat = `<p class="ok">✔ ${esc(camion)} affecté au poste ${esc(r.poste_code)}.</p>`;
        afficherMessage('ok', `Camion ${camion} arrivé au poste ${r.poste_code}.`);
        (f.elements.namedItem('camion') as HTMLInputElement).value = '';
        (f.elements.namedItem('conteneur') as HTMLInputElement).value = '';
      } catch (err) {
        const m = err instanceof ErreurApi ? err.message : String(err);
        resultat = `<p class="refus">✖ ${esc(m)}</p>`;
        afficherMessage('erreur', m);
      }
      await recharger();
    });
    liste.addEventListener('click', async (ev) => {
      const b = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      const id = Number(b.dataset.id);
      if (b.dataset.action === 'depart') await commande(() => api.post(`/api/visites/${id}/depart`), 'Camion parti.');
      if (b.dataset.action === 'voir') selectionner({ type: 'visite', id });
      if (b.dataset.action === 'decharger') await choisirDestination(id);
      if (b.dataset.action === 'charger') {
        changerMode({ type: 'source_pour_camion', plateauId: Number(b.dataset.plateau), camion: b.dataset.camion ?? '' });
        store.onglet = 'selection';
        afficherMessage('info', `Cliquez sur le conteneur à charger sur ${b.dataset.camion}.`);
      }
    });
  }
  const f = formulaire as HTMLFormElement;
  const champCamion = f.elements.namedItem('camion') as HTMLInputElement;
  const codesCamions = [...e.visites.map((v) => v.camion_code), ...e.visites_recentes.map((v) => v.camion_code)];
  if (document.activeElement !== champCamion) champCamion.placeholder = suggestion('CAM-', codesCamions);
  const champCont = f.elements.namedItem('conteneur') as HTMLInputElement;
  champCont.placeholder = suggestion('C-', e.conteneurs.map((c) => c.code));
  const sel = f.elements.namedItem('poste') as HTMLSelectElement;
  const choix = sel.value;
  sel.innerHTML =
    '<option value="">Automatique (premier libre)</option>' +
    e.plan.geometrie.postes
      .map((p) => {
        const occ = e.visites.find((v) => v.poste_id === p.id);
        return `<option value="${esc(p.code)}">${esc(p.code)}${p.statut === 'HORS_SERVICE' ? ' — hors service' : occ ? ` — occupé (${esc(occ.camion_code)})` : ' — libre'}</option>`;
      })
      .join('');
  sel.value = choix;
  if (!champCamion.value && document.activeElement !== champCamion) champCamion.value = '';
  (f.querySelector('.resultat-arrivee') as HTMLElement).innerHTML = resultat;
  const ind = e.indicateurs!;
  liste!.innerHTML = `<h4>Camions présents (${e.visites.length}/${ind.postes_total} postes)</h4>
    ${
      e.visites
        .map((v) => {
          const c = e.conteneurs.find((x) => x.emplacement_id === v.plateau_emplacement_id);
          const r = e.reservations.find((x) => x.emplacement_id === v.plateau_emplacement_id);
          return `<article class="carte camion-carte"><header><button class="lien" data-action="voir" data-id="${v.id}"><b>${esc(v.camion_code)}</b></button>
            <span class="badge">${esc(v.poste_code)}</span> ${c ? `<span class="badge e-en_place">${esc(c.code)}</span>` : '<span class="badge">vide</span>'}</header>
            <p class="note">Arrivé à ${heure(v.arrivee_le)}${r ? ` · impliqué dans M${r.mission_id}` : ''}</p>
            <div class="boutons">
              ${c && !r ? `<button class="secondaire" data-action="decharger" data-id="${c.id}">Décharger…</button>` : ''}
              ${!c && !r ? `<button class="secondaire" data-action="charger" data-plateau="${v.plateau_emplacement_id}" data-camion="${esc(v.camion_code)}">Charger…</button>` : ''}
              <button data-action="depart" data-id="${v.id}" ${r ? `disabled title="Départ impossible : transfert actif (M${r.mission_id})"` : ''}>Départ${c ? ' chargé' : ' à vide'}</button>
            </div>${r ? `<p class="refus">Départ bloqué : transfert actif M${r.mission_id}.</p>` : ''}</article>`;
        })
        .join('') || '<p class="vide">Aucun camion présent.</p>'
    }
    <h4>Visites récentes</h4>
    <table class="tableau compact"><thead><tr><th>Camion</th><th>Poste</th><th>Arrivée</th><th>Départ</th><th>Statut</th></tr></thead><tbody>
    ${e.visites_recentes
      .map(
        (v) => `<tr title="${esc(v.motif_refus ?? '')}"><td>${esc(v.camion_code)}</td><td>${esc(v.poste_code ?? '—')}</td>
        <td>${heure(v.arrivee_le)}${v.conteneur_arrivee ? ` <small>(${esc(v.conteneur_arrivee)})</small>` : ''}</td>
        <td>${heure(v.depart_le)}${v.conteneur_depart ? ` <small>(${esc(v.conteneur_depart)})</small>` : ''}</td>
        <td><span class="badge v-${v.statut.toLowerCase()}">${v.statut === 'PRESENTE' ? 'présent' : v.statut === 'PARTIE' ? 'parti' : 'refusé'}</span>
        ${v.motif_refus ? `<div class="refus petit">${esc(v.motif_refus)}</div>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table>`;
}
