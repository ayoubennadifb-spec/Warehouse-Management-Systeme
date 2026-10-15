/** Panneau « Système » : état de connexion aux sources de données, honnêtement. */
import { api } from '../api.ts';
import { store } from '../store.ts';
import { dateHeure, esc, heure } from '../util.ts';

interface Sante {
  mode: string;
  base: { ok: boolean; latence_ms: number | null; erreur: string | null; nom: string | null; version: string | null; migrations: string[] };
}
let controles:any=null;
let sante: Sante | null = null;
let derniere = 0;

export function rendreSysteme(racine: HTMLElement): void {
  if (Date.now() - derniere > 10_000) {
    derniere = Date.now();
    api
      .get<Sante>('/api/sante')
      .then((s) => {
        sante = s;
        rendreSysteme(racine);
      })
      .catch(() => undefined);
  }
  const src = store.source;
  const b = store.base;
  const e = store.etat;
  const ligne = (ok: boolean | null, titre: string, detail: string) =>
    `<li class="${ok === null ? 'neutre' : ok ? 'ok' : 'ko'}"><i></i><div><b>${titre}</b><span>${detail}</span></div></li>`;
  racine.innerHTML = `<ul class="etat-sys">
    ${ligne(store.flux === 'connecte', 'Flux temps réel (SSE)', store.flux === 'connecte' ? `connecté — dernier message ${heure(new Date(store.dernierMessage).toISOString())}` : store.flux === 'reconnexion' ? 'reconnexion en cours…' : store.flux === 'perdu' ? 'perdu : données potentiellement anciennes' : 'connexion…')}
    ${ligne(b?.ok ?? null, 'PostgreSQL local', b?.ok ? `base « ${esc(sante?.base.nom ?? '…')} », latence ${b.latence_ms ?? '—'} ms` : esc(b?.erreur ?? 'inconnu'))}
    ${ligne(true, 'Mode', src?.mode === 'MATERIEL' ? 'CONNECTÉ (pont matériel attendu)' : 'SIMULATION — confirmations simulées')}
    ${src?.mode === 'MATERIEL' ? ligne(src.connecte, 'Matériel', esc(src.description)) : ligne(null, 'Matériel', 'Aucun matériel connecté (mode simulation). Aucune mesure réelle n’est affichée.')}
  </ul>
  <dl class="grille-dl">
    <dt>Source</dt><dd>${esc(src?.description ?? '—')}</dd>
    <dt>Dernier événement</dt><dd>#${e?.dernier_evenement_id ?? '—'}</dd>
    <dt>Dernière synchro</dt><dd>${store.derniereSynchro ? dateHeure(new Date(store.derniereSynchro).toISOString()) : '—'}</dd>
    <dt>Version PostgreSQL</dt><dd class="petit">${esc(sante?.base.version ?? '—')}</dd>
    <dt>Migrations</dt><dd class="petit">${esc(sante?.base.migrations.join(', ') ?? '—')}</dd>
    <dt>Plan actif</dt><dd>${e?.plan ? `n°${e.plan.numero} — ${esc(e.plan.libelle)}` : '—'}</dd>
    <dt>Unité de manutention</dt><dd>${esc(e?.unite?.description ?? '—')}</dd>
  </dl>
  <div class="carte"><h3>Préparation Arduino</h3><p>Aucun portique connecté. Le PC calculera les chemins et analysera les images ; l’Arduino pilotera les moteurs et lira les fins de course.</p><button id="tester-controles">Tester les contrôles simulés</button>${controles?`<ul>${controles.checks.map((c:any)=>`<li>${c.passed?'✓':'✕'} ${esc(c.name)}</li>`).join('')}</ul><p class="note">Essai logiciel isolé ; aucun moteur commandé, aucun inventaire modifié.</p>`:''}</div>
  <p class="note">Le mot de passe PostgreSQL reste côté serveur (fichier .env local) ; il n’est jamais transmis au navigateur.</p>`;
  racine.querySelector('#tester-controles')?.addEventListener('click',async()=>{controles=await api.post('/api/hardware/self-test');rendreSysteme(racine);});
}
