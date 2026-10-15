/** Orchestration de l'interface : rendu de la scène, panneaux, indicateurs et état de connexion. */
import './styles.css';
import { api } from './api.ts';
import { actionsVue, modeDeclaration } from './actions.ts';
import { connecterFlux, donneesPerimees } from './flux.ts';
import { abonner, changerMode, commande, recharger, selectionner, store } from './store.ts';
import { esc, heure } from './util.ts';
import { VueDessus } from './vue-dessus.ts';
import { Scene3D } from './scene3d.ts';
import { brancherSelection, rendreSelection } from './panneaux/selection.ts';
import { brancherMissions, rendreMissions } from './panneaux/missions.ts';
import { rendreCamions } from './panneaux/camions.ts';
import { brancherHistorique, rendreHistorique } from './panneaux/historique.ts';
import { brancherParametres, rendreParametres } from './panneaux/parametres.ts';
import { rendreSysteme } from './panneaux/systeme.ts';
import { rendreVision } from './panneaux/vision.ts';
import { rendreAntisway } from './panneaux/antisway.ts';

const q = (s: string) => document.querySelector(s) as HTMLElement;
const contenu = (o: string) => q(`[data-contenu="${o}"]`);

const vue2d = new VueDessus(q('#vue2d'), actionsVue);
let scene: Scene3D | null = null;
try {
  scene = new Scene3D(q('#vue3d'), actionsVue);
} catch (e) {
  q('#vue3d').insertAdjacentHTML('beforeend', `<p class="vide">Vue 3D indisponible (WebGL) : ${esc((e as Error).message)}. La vue du dessus reste utilisable.</p>`);
}

const PANNEAUX: Record<string, (r: HTMLElement) => void> = {
  selection: rendreSelection,
  missions: rendreMissions,
  camions: rendreCamions,
  historique: rendreHistorique,
  parametres: rendreParametres,
  systeme: rendreSysteme,
  vision: rendreVision,
  antisway: rendreAntisway,
};
brancherSelection(contenu('selection'));
brancherMissions(contenu('missions'));
brancherHistorique(contenu('historique'));
brancherParametres(contenu('parametres'));

// ------------------------------------------------------------------ entête
function rendreEntete(): void {
  const e = store.etat;
  const src = store.source;
  const sim = (src?.mode ?? e?.mode) !== 'MATERIEL';
  q('#badges').innerHTML = `
    <span class="badge-mode ${sim ? 'sim' : 'connecte'}" title="${esc(src?.description ?? '')}">${sim ? 'MODE SIMULATION' : 'MODE CONNECTÉ'}</span>
    ${e?.demo ? '<span class="badge-mode demo" title="Jeu de données fictif : ne représente pas le mapping réel de la maquette">DONNÉES DE DÉMONSTRATION</span>' : ''}
    ${e?.plan ? `<span class="badge-mode plan" title="${esc(e.plan.libelle)}">Plan n°${e.plan.numero}</span>` : ''}`;
  const pastille = (ok: boolean | null, lib: string, titre: string) => `<span class="pastille-cnx ${ok === null ? 'neutre' : ok ? 'ok' : 'ko'}" title="${esc(titre)}"><i></i>${lib}</span>`;
  const fluxOk = store.flux === 'connecte';
  // Sans flux, l'état du serveur et de la base n'est plus connu : on ne l'affiche pas comme « bon ».
  q('#connexions').innerHTML = [
    fluxOk || store.erreurChargement
      ? pastille(store.erreurChargement === null && !!e, 'API', store.erreurChargement ?? 'Serveur local joignable')
      : pastille(null, 'API : ?', 'État inconnu : flux temps réel interrompu'),
    fluxOk
      ? pastille(store.base?.ok ?? null, 'PostgreSQL', store.base?.ok ? `Latence ${store.base.latence_ms} ms` : (store.base?.erreur ?? 'inconnu'))
      : pastille(null, 'PostgreSQL : ?', 'État inconnu : flux temps réel interrompu'),
    pastille(fluxOk, 'Temps réel', fluxOk ? 'Flux SSE connecté' : store.flux === 'reconnexion' ? 'Reconnexion…' : 'Flux perdu'),
    pastille(sim ? null : !!src?.connecte, sim ? 'Matériel : non connecté' : src?.connecte ? 'Matériel' : 'Matériel : absent', sim ? 'Mode simulation : aucun matériel, aucune mesure réelle' : (src?.description ?? '')),
  ].join('');
  const cs = q('#commandes-sim');
  if (!sim) {
    cs.innerHTML = '';
    return;
  }
  const pause = !!src?.en_pause;
  cs.innerHTML = `
    <button data-sim="${pause ? 'reprise' : 'pause'}" class="${pause ? '' : 'secondaire'}">${pause ? '▶ Reprendre la simulation' : '⏸ Pause'}</button>
    <label class="champ-inline">Vitesse <select id="vitesse">${[0.5, 1, 2, 4, 8].map((v) => `<option value="${v}" ${src?.vitesse === v ? 'selected' : ''}>×${v}</option>`).join('')}</select></label>
    <button data-sim="incident" class="danger" ${src?.mission_id ? '' : 'disabled title="Aucune mission en cours"'}>Incident simulé</button>`;
}

q('#commandes-sim').addEventListener('click', async (ev) => {
  const b = (ev.target as HTMLElement).closest('[data-sim]') as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  const a = b.dataset.sim;
  if (a === 'pause') await commande(() => api.post('/api/simulation/pause'), 'Simulation en pause : la mission en cours est suspendue.');
  if (a === 'reprise') await commande(() => api.post('/api/simulation/reprise'), 'Simulation reprise.');
  if (a === 'incident') await commande(() => api.post('/api/simulation/incident', { motif: 'Arrêt d’urgence simulé (test)' }), 'Incident simulé : mission interrompue.');
});
q('#commandes-sim').addEventListener('change', async (ev) => {
  const s = ev.target as HTMLSelectElement;
  if (s.id === 'vitesse') await commande(() => api.post('/api/simulation/vitesse', { facteur: Number(s.value) }));
});

// ------------------------------------------------------------------ indicateurs et bandeaux
function rendreKpis(): void {
  const i = store.etat?.indicateurs;
  if (!i) {
    q('#kpis').innerHTML = '';
    return;
  }
  const tuile = (val: string, lib: string, detail: string, alerte = false) =>
    `<div class="kpi ${alerte ? 'alerte' : ''}"><div class="kpi-val">${val}</div><div class="kpi-lib">${lib}</div><div class="kpi-detail">${detail}</div></div>`;
  q('#kpis').innerHTML = [
    tuile(`${i.conteneurs_presents}<small>/${i.nb_conteneurs_max}</small>`, 'Conteneurs présents', `${i.conteneurs_stockage} stockés · ${i.conteneurs_camions} sur camion · ${i.conteneurs_transfert} en transfert (périmètre ${i.perimetre_capacite === 'ZONE' ? 'maquette' : 'stockage'})`),
    tuile(`${i.emplacements_occupes}<small>/${i.emplacements_total}</small>`, 'Emplacements occupés', `${i.positions_sol_total} positions au sol × niveaux`),
    tuile(`${i.postes_disponibles}<small>/${i.postes_total}</small>`, 'Postes camion libres', `${i.postes_occupes} occupé(s)`),
    tuile(`${i.missions_en_cours}`, 'Mission en cours', `${i.missions_en_attente} en attente`),
    tuile(`${i.conteneurs_incertains + i.missions_interrompues}`, 'Incertitudes', `${i.conteneurs_incertains} position(s) incertaine(s) · ${i.missions_interrompues} interrompue(s)`, i.conteneurs_incertains + i.missions_interrompues > 0),
  ].join('');
  q('#cpt-missions').textContent = i.missions_en_cours + i.missions_en_attente + i.missions_interrompues ? String(i.missions_en_cours + i.missions_en_attente + i.missions_interrompues) : '';
}

function rendreBandeaux(): void {
  const e = store.etat;
  const parts: string[] = [];
  document.body.classList.toggle('hors-ligne', donneesPerimees() || !!store.erreurChargement);
  if (store.erreurChargement)
    parts.push(`<div class="bandeau ko"><b>Données indisponibles.</b> ${esc(store.erreurChargement)} — affichage figé à ${store.derniereSynchro ? heure(new Date(store.derniereSynchro).toISOString()) : '—'}. Les commandes sont désactivées.</div>`);
  else if (donneesPerimees())
    parts.push(`<div class="bandeau ko"><b>Connexion perdue ou base injoignable.</b> Les données affichées datent de ${heure(new Date(store.derniereSynchro).toISOString())} et peuvent être anciennes. Commandes désactivées ; reprise automatique à la reconnexion.</div>`);
  if (e && !e.plan) parts.push('<div class="bandeau ko">Aucun plan actif : lancez <code>npm run db:seed</code>.</div>');
  if (store.source?.bloque) parts.push(`<div class="bandeau avert">${esc(store.source.bloque)}</div>`);
  for (const a of e?.alertes ?? [])
    parts.push(`<div class="bandeau ${a.gravite === 'CRITIQUE' ? 'ko' : 'avert'}"><span><b>${a.statut === 'ACQUITTEE' ? 'Alerte acquittée' : 'Alerte'}</b> — ${esc(a.message)}</span>
      <span class="boutons">${a.conteneur_id && e?.conteneurs.some((c) => c.id === a.conteneur_id && c.etat === 'INCERTAINE') ? `<button data-alerte-declarer="${a.conteneur_id}">Déclarer la position</button>` : ''}
      ${a.mission_id ? `<button class="secondaire" data-alerte-mission="${a.mission_id}">Voir la mission</button>` : ''}
      ${a.statut === 'OUVERTE' ? `<button class="secondaire" data-alerte-acquitter="${a.id}">Acquitter</button>` : ''}</span></div>`);
  q('#bandeaux').innerHTML = parts.join('');
}
q('#bandeaux').addEventListener('click', async (ev) => {
  const b = ev.target as HTMLElement;
  if (b.dataset.alerteDeclarer) await modeDeclaration(Number(b.dataset.alerteDeclarer));
  if (b.dataset.alerteMission) activerOnglet('missions');
  if (b.dataset.alerteAcquitter) await commande(() => api.post(`/api/alertes/${b.dataset.alerteAcquitter}/acquitter`));
});

function rendreBandeauMode(): void {
  const m = store.mode;
  const el = q('#bandeau-mode');
  el.hidden = m.type === 'normal';
  if (m.type === 'destination') el.innerHTML = 'Choix de la destination : <b>cases vertes</b> = possibles. Survolez une case grisée pour connaître la raison du refus. <button data-annuler-mode class="secondaire">Annuler</button>';
  if (m.type === 'declaration') el.innerHTML = 'Déclaration de la position réelle : choisissez l’emplacement constaté. <button data-annuler-mode class="secondaire">Annuler</button>';
  if (m.type === 'source_pour_camion') el.innerHTML = `Chargement de <b>${esc(m.camion)}</b> : cliquez sur le conteneur à charger (sommet d’une pile). <button data-annuler-mode class="secondaire">Annuler</button>`;
}
q('#bandeau-mode').addEventListener('click', (ev) => {
  if ((ev.target as HTMLElement).hasAttribute('data-annuler-mode')) changerMode({ type: 'normal' });
});

// ------------------------------------------------------------------ onglets et vues
function activerOnglet(o: string): void {
  store.onglet = o;
  rendrePanneauActif();
}
function rendrePanneauActif(): void {
  const visionActive = store.onglet === 'vision';
  q('.scene').classList.toggle('vision-active', visionActive);
  q('#vision-guide').hidden = !visionActive;
  q('.scene').classList.toggle('sway-active', store.onglet === 'antisway');
  q('#sway-guide').hidden = store.onglet !== 'antisway';
  document.querySelectorAll<HTMLElement>('[data-onglet]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.onglet === store.onglet)));
  document.querySelectorAll<HTMLElement>('[data-contenu]').forEach((c) => (c.hidden = c.dataset.contenu !== store.onglet));
  const racine = contenu(store.onglet);
  // Ne pas effacer une saisie en cours (les formulaires persistants gèrent eux-mêmes leur mise à jour)
  const actif = document.activeElement;
  const saisie = actif && racine.contains(actif) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(actif.tagName);
  if (saisie && ['selection', 'historique'].includes(store.onglet)) return;
  PANNEAUX[store.onglet]?.(racine);
}
q('#onglets').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('[data-onglet]') as HTMLElement | null;
  if (b) activerOnglet(b.dataset.onglet!);
});

function appliquerVue(): void {
  const v = q('#vues');
  v.dataset.vue = store.vue;
  document.querySelectorAll<HTMLElement>('[data-vue]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.vue === store.vue)));
  q('#cameras').hidden = store.vue === '2d';
}
document.querySelectorAll<HTMLElement>('[data-vue]').forEach((b) =>
  b.addEventListener('click', () => {
    store.vue = b.dataset.vue as typeof store.vue;
    appliquerVue();
  }),
);
document.querySelectorAll<HTMLElement>('[data-camera]').forEach((b) => b.addEventListener('click', () => scene?.vue(b.dataset.camera as 'iso')));
(q('#cotes') as HTMLInputElement).addEventListener('change', (ev) => {
  store.cotes = (ev.target as HTMLInputElement).checked;
  vue2d.rendre();
});
if (window.matchMedia('(max-width: 760px)').matches) store.vue = '2d';
appliquerVue();
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (store.mode.type !== 'normal') changerMode({ type: 'normal' });
    else selectionner(null);
  }
});

// ------------------------------------------------------------------ toast
function rendreToast(): void {
  const t = q('#toast');
  const m = store.message;
  t.hidden = !m;
  if (m) {
    t.className = `toast ${m.type}`;
    t.textContent = m.texte;
  }
}

// ------------------------------------------------------------------ abonnements
let derniereTelemetriePanneau = 0;
abonner((raison) => {
  if (raison === 'telemetrie') {
    vue2d.majUnite();
    scene?.majUnite();
    if (store.onglet === 'missions' && performance.now() - derniereTelemetriePanneau > 250) {
      derniereTelemetriePanneau = performance.now();
      rendreMissions(contenu('missions'));
    }
    return;
  }
  if (raison === 'message') return rendreToast();
  if (raison === 'battement' || raison === 'flux') {
    rendreEntete();
    rendreBandeaux();
    if (store.onglet === 'systeme') rendreSysteme(contenu('systeme'));
    return;
  }
  rendreEntete();
  rendreKpis();
  rendreBandeaux();
  rendreBandeauMode();
  vue2d.rendre();
  scene?.rendre();
  rendrePanneauActif();
});

await recharger();
connecterFlux();
if (window.location.hash === '#anti-ballant') store.onglet = 'antisway';
rendrePanneauActif();
window.addEventListener('hashchange', () => {
  if (window.location.hash === '#anti-ballant') activerOnglet('antisway');
});
