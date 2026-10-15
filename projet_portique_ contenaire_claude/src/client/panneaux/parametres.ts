/**
 * Panneau « Paramètres » : modification de la configuration SANS réécrire le programme.
 * Vérifier → (géométrie calculée par le serveur) → Enregistrer une version → Analyse d'impact → Activer.
 */
import { api, ErreurApi } from '../api.ts';
import { afficherMessage, recharger, store } from '../store.ts';
import { dateHeure, esc, mm } from '../util.ts';
import type { Parametres } from '../types.ts';

type Champ = [chemin: string, libelle: string, type: 'n' | 'nv' | 'i' | 't' | 's', aide?: string, options?: [string, string][]];

const GROUPES: [string, Champ[]][] = [
  ['Version', [['libelle', 'Libellé de la version', 't']]],
  [
    'Espace et zones',
    [
      ['espace.longueur_x_mm', 'Longueur totale X (mm)', 'n'],
      ['espace.largeur_y_mm', 'Largeur totale Y (mm)', 'n'],
      ['zones.transport_longueur_x_mm', 'Longueur zone transport X (mm)', 'n', 'Stockage = total − transport'],
      ['zones.transport_cote', 'Zone transport placée à', 's', 'Convention modifiable', [['X_MAX', 'l’extrémité X max'], ['X_MIN', 'l’extrémité X min']]],
    ],
  ],
  [
    'Conteneur',
    [
      ['conteneur.longueur_mm', 'Longueur (mm, suivant X)', 'n'],
      ['conteneur.largeur_mm', 'Largeur (mm, suivant Y)', 'n'],
      ['conteneur.hauteur_mm', 'Hauteur (mm)', 'n'],
    ],
  ],
  [
    'Grille de stockage',
    [
      ['grille.nb_positions_x', 'Positions suivant X', 'i'],
      ['grille.nb_positions_y', 'Positions suivant Y', 'i'],
      ['grille.nb_niveaux_max', 'Niveaux maximum', 'i'],
      ['grille.marge_x_mm', 'Marge X (mm)', 'nv', 'vide = automatique'],
      ['grille.espacement_x_mm', 'Espacement X (mm)', 'nv', 'vide = automatique'],
      ['grille.marge_y_mm', 'Marge Y (mm)', 'nv', 'vide = automatique'],
      ['grille.espacement_y_mm', 'Espacement Y (mm)', 'nv', 'vide = automatique'],
    ],
  ],
  [
    'Capacité',
    [
      ['capacite.nb_conteneurs_max', 'Conteneurs maximum', 'i'],
      ['capacite.perimetre', 'Périmètre compté', 's', 'Hypothèse à confirmer', [['ZONE', 'toute la maquette (stockage + camions + transferts)'], ['STOCKAGE', 'zone de stockage seulement']]],
    ],
  ],
  [
    'Camion (hauteurs illustratives)',
    [
      ['camion.cabine_longueur_mm', 'Cabine longueur (mm)', 'n'],
      ['camion.cabine_largeur_mm', 'Cabine largeur (mm)', 'n'],
      ['camion.cabine_hauteur_mm', 'Cabine hauteur (mm)', 'n', 'illustrative'],
      ['camion.plateau_longueur_mm', 'Plateau longueur (mm)', 'n'],
      ['camion.plateau_largeur_mm', 'Plateau largeur (mm)', 'n'],
      ['camion.plateau_hauteur_mm', 'Plateau hauteur (mm)', 'n', 'illustrative'],
    ],
  ],
  [
    'Postes camion',
    [
      ['postes.nb_postes', 'Nombre de postes', 'i'],
      ['postes.cote_cabine', 'Cabine orientée vers', 's', '', [['X_MAX', 'X max'], ['X_MIN', 'X min']]],
    ],
  ],
];

let monte = false;
let charge: number | null = null;
let brouillon: { id: number; numero: number; analyse: Analyse } | null = null;

interface Analyse {
  possible: boolean;
  bloquants: string[];
  conserves: { conteneur: string; emplacement: string }[];
  impactes: { conteneur: string; emplacement: string; raison: string }[];
}

function lire(o: unknown, chemin: string): unknown {
  return chemin.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o);
}
function ecrire(o: Record<string, unknown>, chemin: string, v: unknown): void {
  const ks = chemin.split('.');
  let c = o;
  for (const k of ks.slice(0, -1)) c = c[k] as Record<string, unknown>;
  c[ks[ks.length - 1]] = v;
}

function remplir(f: HTMLFormElement, p: Parametres): void {
  for (const [, champs] of GROUPES)
    for (const [chemin, , type] of champs) {
      const el = f.elements.namedItem(chemin) as HTMLInputElement | HTMLSelectElement;
      const v = lire(p, chemin);
      el.value = v === null || v === undefined ? '' : String(v);
      void type;
    }
  (f.elements.namedItem('postes.positions') as HTMLTextAreaElement).value = (p.postes.positions ?? []).map((x) => `${x.code};${x.centre_x_mm};${x.centre_y_mm}`).join('\n');
}

function lireFormulaire(f: HTMLFormElement): Parametres {
  const base = structuredClone(store.etat!.plan!.parametres) as unknown as Record<string, unknown>;
  for (const [, champs] of GROUPES)
    for (const [chemin, , type] of champs) {
      const brut = (f.elements.namedItem(chemin) as HTMLInputElement).value.trim().replace(',', '.');
      let v: unknown = brut;
      if (type === 'n' || type === 'i') v = brut === '' ? NaN : Number(brut);
      if (type === 'nv') v = brut === '' ? null : Number(brut);
      ecrire(base, chemin, v);
    }
  const lignes = (f.elements.namedItem('postes.positions') as HTMLTextAreaElement).value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  ecrire(
    base,
    'postes.positions',
    lignes.length
      ? lignes.map((l) => {
          const [code, x, y] = l.split(/[;\s]+/);
          return { code, centre_x_mm: Number(x?.replace(',', '.')), centre_y_mm: Number(y?.replace(',', '.')) };
        })
      : null,
  );
  return base as unknown as Parametres;
}

interface PlanCalcule {
  ok: boolean;
  erreurs: string[];
  avertissements: string[];
  zones: { code: string; x_min: number; x_max: number; y_min: number; y_max: number }[];
  repartition_x: { marge_debut: number; espacement: number; marge_fin: number; pas: number; auto: boolean } | null;
  repartition_y: { marge_debut: number; espacement: number; marge_fin: number; pas: number; auto: boolean } | null;
  positions: { code: string; centre_x: number; centre_y: number }[];
  postes: { code: string; centre_x: number; centre_y: number; longueur_x: number; largeur_y: number; plateau: { x: number; y: number; z: number } }[];
  camion: { longueur_totale: number; largeur: number };
  nb_positions_sol: number;
  nb_emplacements: number;
  hauteur_pile_max: number;
}

function apercu(p: Parametres, c: PlanCalcule): string {
  const L = p.espace.longueur_x_mm;
  const W = p.espace.largeur_y_mm;
  const sy = (y: number) => W - y;
  const parts = c.zones.map(
    (z) => `<rect class="${z.code === 'STOCKAGE' ? 'zone-stockage' : 'zone-transport'}" x="${z.x_min}" y="${sy(z.y_max)}" width="${z.x_max - z.x_min}" height="${z.y_max - z.y_min}"/>`,
  );
  for (const q of c.positions)
    parts.push(`<rect class="apercu-case" x="${q.centre_x - p.conteneur.longueur_mm / 2}" y="${sy(q.centre_y + p.conteneur.largeur_mm / 2)}" width="${p.conteneur.longueur_mm}" height="${p.conteneur.largeur_mm}"/>`);
  for (const q of c.postes) {
    parts.push(`<rect class="apercu-camion" x="${q.centre_x - c.camion.longueur_totale / 2}" y="${sy(q.centre_y + c.camion.largeur / 2)}" width="${c.camion.longueur_totale}" height="${c.camion.largeur}"/>`);
    parts.push(`<text class="lib-poste" x="${q.centre_x}" y="${sy(q.centre_y) + 4}" text-anchor="middle">${esc(q.code)}</text>`);
  }
  return `<svg class="apercu" viewBox="-10 -10 ${L + 20} ${W + 20}" role="img" aria-label="Aperçu du plan vérifié">${parts.join('')}</svg>`;
}

function rendreVerification(p: Parametres, c: PlanCalcule): string {
  const rx = c.repartition_x;
  const ry = c.repartition_y;
  return `<div class="carte ${c.ok ? 'ok-bord' : 'ko-bord'}">
    <h4>${c.ok ? '✔ Géométrie valide' : '✖ Géométrie invalide'}</h4>
    ${c.erreurs.map((x) => `<p class="refus">${esc(x)}</p>`).join('')}
    ${c.avertissements.map((x) => `<p class="avertissement petit">${esc(x)}</p>`).join('')}
    ${
      c.ok
        ? `<dl class="grille-dl">
      ${c.zones.map((z) => `<dt>${z.code === 'STOCKAGE' ? 'Stockage' : 'Transport'}</dt><dd>X ${mm(z.x_min)} → ${mm(z.x_max)} (${mm(z.x_max - z.x_min)} × ${mm(z.y_max - z.y_min)} mm)</dd>`).join('')}
      <dt>Répartition X</dt><dd>marge ${mm(rx!.marge_debut, 3)} · espacement ${mm(rx!.espacement, 3)} · pas ${mm(rx!.pas, 3)} · marge fin ${mm(rx!.marge_fin, 3)} mm</dd>
      <dt>Répartition Y</dt><dd>marge ${mm(ry!.marge_debut, 3)} · espacement ${mm(ry!.espacement, 3)} · pas ${mm(ry!.pas, 3)} · marge fin ${mm(ry!.marge_fin, 3)} mm</dd>
      <dt>Positions au sol</dt><dd><b>${c.nb_positions_sol}</b></dd>
      <dt>Emplacements</dt><dd><b>${c.nb_emplacements}</b> (${c.nb_positions_sol} × ${p.grille.nb_niveaux_max} niveaux)</dd>
      <dt>Pile maximale</dt><dd>${mm(c.hauteur_pile_max)} mm (≠ hauteur du portique)</dd>
      <dt>Camion</dt><dd>${mm(c.camion.longueur_totale)} × ${mm(c.camion.largeur)} mm</dd>
      <dt>Postes</dt><dd>${c.postes.map((q) => `${esc(q.code)} (${mm(q.centre_x)} ; ${mm(q.centre_y)})`).join(', ') || 'aucun'}</dd></dl>
      ${apercu(p, c)}`
        : ''
    }</div>`;
}

function rendreAnalyse(): string {
  if (!brouillon) return '';
  const a = brouillon.analyse;
  return `<div class="carte">
    <h4>Version n°${brouillon.numero} enregistrée (brouillon)</h4>
    ${a.bloquants.map((x) => `<p class="refus">${esc(x)}</p>`).join('')}
    <p>${a.conserves.length} conteneur(s) gardent exactement le même lieu physique (rattachés au nouveau plan, aucun déplacement fictif).</p>
    ${
      a.impactes.length
        ? `<div class="avertissement"><b>${a.impactes.length} conteneur(s) occupent des emplacements modifiés</b> :
         <ul class="petit">${a.impactes.slice(0, 12).map((i) => `<li>${esc(i.conteneur)} (${esc(i.emplacement)}) : ${esc(i.raison)}</li>`).join('')}${a.impactes.length > 12 ? '<li>…</li>' : ''}</ul>
         Si vous activez quand même, ils passeront en <b>position incertaine</b> (dernière position connue conservée) et devront être déclarés.</div>`
        : ''
    }
    <div class="boutons">
      ${a.possible && !a.impactes.length ? `<button data-action="activer" data-id="${brouillon.id}">Activer cette version</button>` : ''}
      ${a.possible && a.impactes.length ? `<button class="danger" data-action="activer-forcer" data-id="${brouillon.id}">Activer (positions incertaines)</button>` : ''}
      <button class="secondaire" data-action="fermer-analyse">Fermer</button>
    </div></div>`;
}

export function rendreParametres(racine: HTMLElement): void {
  const e = store.etat;
  if (!e?.plan) return;
  if (!monte) {
    monte = true;
    racine.innerHTML = `<p class="note">Les paramètres sont des <b>hypothèses modifiables</b>. Une modification crée une nouvelle <b>version du plan</b> ; les versions activées restent dans l’historique, immuables.</p>
      <form id="form-params" class="form-params" novalidate>
      ${GROUPES.map(
        ([titre, champs]) => `<fieldset><legend>${esc(titre)}</legend><div class="grille-champs">${champs
          .map(([chemin, lib, type, aide, options]) =>
            type === 's'
              ? `<label class="champ">${esc(lib)}<select name="${chemin}">${options!.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>${aide ? `<small>${esc(aide)}</small>` : ''}</label>`
              : `<label class="champ ${type === 't' ? 'large' : ''}">${esc(lib)}<input name="${chemin}" ${type === 't' ? 'maxlength="200"' : 'inputmode="decimal"'} ${type === 'nv' ? 'placeholder="auto"' : ''}>${aide ? `<small>${esc(aide)}</small>` : ''}</label>`,
          )
          .join('')}${
          titre === 'Postes camion'
            ? `<label class="champ large">Positions manuelles (facultatif)<textarea name="postes.positions" rows="3" placeholder="vide = disposition automatique&#10;P1;900;62.5"></textarea><small>une ligne par poste : code;centre_x;centre_y (mm)</small></label>`
            : ''
        }</div></fieldset>`,
      ).join('')}
      <div class="boutons collant">
        <button type="button" data-action="verifier" class="secondaire">Vérifier la géométrie</button>
        <button type="button" data-action="enregistrer">Enregistrer comme nouvelle version</button>
        <button type="button" data-action="defaut" class="secondaire">Valeurs par défaut</button>
      </div></form>
      <div id="verif"></div><div id="analyse"></div><div id="versions"></div>`;
  }
  const f = racine.querySelector('#form-params') as HTMLFormElement;
  if (charge !== e.plan.id) {
    charge = e.plan.id;
    remplir(f, e.plan.parametres);
  }
  (racine.querySelector('#analyse') as HTMLElement).innerHTML = rendreAnalyse();
  (racine.querySelector('#versions') as HTMLElement).innerHTML = `<h4>Versions du plan</h4>
    <table class="tableau compact"><thead><tr><th>N°</th><th>Libellé</th><th>Statut</th><th>Pos.</th><th>Empl.</th><th>Postes</th><th>Activée</th><th></th></tr></thead><tbody>
    ${e.versions
      .map(
        (v) => `<tr><td>${v.numero}</td><td>${esc(v.libelle)}</td><td><span class="badge p-${v.statut.toLowerCase()}">${esc(v.statut.toLowerCase())}</span></td>
      <td>${v.nb_positions_sol}</td><td>${v.nb_emplacements}</td><td>${v.nb_postes}</td><td>${dateHeure(v.active_le)}</td>
      <td><button class="lien" data-action="charger" data-id="${v.id}">charger</button>${v.statut === 'BROUILLON' ? ` · <button class="lien" data-action="analyser" data-id="${v.id}" data-numero="${v.numero}">analyser</button>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table>`;
}

export function brancherParametres(racine: HTMLElement): void {
  racine.addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!b) return;
    const f = racine.querySelector('#form-params') as HTMLFormElement;
    const verif = racine.querySelector('#verif') as HTMLElement;
    try {
      switch (b.dataset.action) {
        case 'verifier': {
          const p = lireFormulaire(f);
          const c = await api.post<PlanCalcule>('/api/plans/verifier', p);
          verif.innerHTML = rendreVerification(p, c);
          break;
        }
        case 'enregistrer': {
          const p = lireFormulaire(f);
          const c = await api.post<PlanCalcule>('/api/plans/verifier', p);
          verif.innerHTML = rendreVerification(p, c);
          if (!c.ok) return;
          brouillon = await api.post<{ id: number; numero: number; analyse: Analyse }>('/api/plans', { parametres: p });
          afficherMessage('ok', `Version n°${brouillon.numero} enregistrée (brouillon). Vérifiez l’analyse avant activation.`);
          await recharger();
          break;
        }
        case 'analyser': {
          const id = Number(b.dataset.id);
          brouillon = { id, numero: Number(b.dataset.numero), analyse: await api.get<Analyse>(`/api/plans/${id}/impact`) };
          (racine.querySelector('#analyse') as HTMLElement).innerHTML = rendreAnalyse();
          break;
        }
        case 'activer':
        case 'activer-forcer': {
          const id = Number(b.dataset.id);
          await api.post(`/api/plans/${id}/activer`, { forcer: b.dataset.action === 'activer-forcer' });
          afficherMessage('ok', 'Nouvelle version du plan activée.');
          brouillon = null;
          verif.innerHTML = '';
          await recharger();
          break;
        }
        case 'fermer-analyse':
          brouillon = null;
          (racine.querySelector('#analyse') as HTMLElement).innerHTML = '';
          break;
        case 'charger': {
          const v = store.etat!.versions.find((x) => x.id === Number(b.dataset.id));
          if (v) remplir(f, v.parametres);
          verif.innerHTML = '';
          break;
        }
        case 'defaut':
          remplir(f, await api.get<Parametres>('/api/plans/defaut'));
          verif.innerHTML = '';
          break;
      }
    } catch (err) {
      const m = err instanceof ErreurApi ? err.message : String(err);
      afficherMessage('erreur', m);
      if (err instanceof ErreurApi && err.details && b.dataset.action?.startsWith('activer')) {
        brouillon = brouillon ? { ...brouillon, analyse: err.details as Analyse } : null;
        (racine.querySelector('#analyse') as HTMLElement).innerHTML = rendreAnalyse();
      }
    }
  });
}
