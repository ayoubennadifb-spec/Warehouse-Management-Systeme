/**
 * Test d'interface de bout en bout (navigateur réel : Edge ou Chrome installés, via playwright-core).
 *   npm run build && npm run test:ui
 * Utilise la base DATABASE_URL_TEST (EFFACÉE puis rechargée avec la démonstration).
 * Captures d'écran : tests/ui/captures/
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { chargerEnv, RACINE } from '../../src/server/config.ts';
import { creerPool, migrer, viderSchema } from '../../src/server/db.ts';
import { semerDemo } from '../../src/server/demo.ts';

chargerEnv();
const urlTest = process.env.DATABASE_URL_TEST!;
process.env.DATABASE_URL = urlTest;
process.env.PORT = '3099';
process.env.SOURCE_EVENEMENTS = 'SIMULATION';
const dossier = path.join(RACINE, 'tests', 'ui', 'captures');
mkdirSync(dossier, { recursive: true });

const pool = creerPool(urlTest);
await viderSchema(pool);
await migrer(pool, () => undefined);
await semerDemo(pool);
await pool.end();

const { demarrerServeur } = await import('../../src/server/index.ts');
const srv = await demarrerServeur();
const BASE = 'http://127.0.0.1:3099';
const canaux = ['msedge', 'chrome'];
let navigateur;
for (const channel of canaux) {
  try {
    navigateur = await chromium.launch({ channel, headless: true });
    console.log(`Navigateur : ${channel}`);
    break;
  } catch {
    /* essai suivant */
  }
}
if (!navigateur) throw new Error('Ni Edge ni Chrome trouvés.');

const resultats: string[] = [];
const ok = (m: string) => {
  resultats.push(`✔ ${m}`);
  console.log(`✔ ${m}`);
};

async function ouvrir(l: number, h: number): Promise<{ page: Page; erreurs: string[] }> {
  const page = await navigateur!.newPage({ viewport: { width: l, height: h }, deviceScaleFactor: 1 });
  const erreurs: string[] = [];
  // Les refus métier (409/422) sont des réponses attendues, pas des erreurs JavaScript.
  page.on('console', (m: { type(): string; text(): string }) => {
    if (m.type() === 'error' && !/status of (409|422)/.test(m.text())) erreurs.push(m.text());
  });
  page.on('pageerror', (e: Error) => erreurs.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('.kpi');
  await page.waitForSelector('.svg-dessus .case');
  await page.waitForTimeout(1200);
  return { page, erreurs };
}

async function debordement(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

try {
  // ---------------------------------------------------------- ordinateur : parcours complet
  {
    const { page, erreurs } = await ouvrir(1600, 1000);
    assert.equal(await page.locator('.svg-dessus g.case').count(), 49);
    ok('49 cases dessinées dans la vue du dessus');
    assert.match(await page.locator('#kpis').innerText(), /41\s*\/60/);
    assert.match(await page.locator('#kpis').innerText(), /40\s*\/147/);
    ok('indicateurs : 41/60 conteneurs, 40/147 emplacements');
    assert.match(await page.locator('#badges').innerText(), /MODE SIMULATION/);
    assert.match(await page.locator('#badges').innerText(), /DÉMONSTRATION/);
    ok('badges « mode simulation » et « données de démonstration » visibles');
    assert.equal(await page.locator('#vue3d canvas').count(), 1);
    await page.screenshot({ path: path.join(dossier, '1-ordinateur-1600.png') });

    // Sélection d'une pile de 2 conteneurs → panneau, puis sélection du conteneur inférieur (non accessible)
    const pile2 = page.locator('.svg-dessus g.case.h2').first();
    await pile2.click();
    await page.waitForSelector('[data-contenu="selection"] table');
    await page.locator('[data-contenu="selection"] [data-action="selectionner-conteneur"]').last().click();
    await page.waitForSelector('[data-contenu="selection"] .refus');
    assert.match(await page.locator('[data-contenu="selection"]').innerText(), /n’est pas au sommet/);
    ok('conteneur du dessous : refus expliqué (« pas au sommet »)');
    // Conteneur du sommet → choisir une destination → case verte → lancer
    await pile2.click();
    await page.locator('[data-contenu="selection"] [data-action="selectionner-conteneur"]').first().click();
    await page.locator('[data-action="choisir-destination"]').click();
    await page.waitForSelector('.svg-dessus g.case.cible-ok');
    const nbOk = await page.locator('.svg-dessus g.case.cible-ok').count();
    ok(`mode destination : ${nbOk} cases possibles en vert`);
    await page.screenshot({ path: path.join(dossier, '2-choix-destination.png') });
    await page.locator('.svg-dessus g.case.cible-ok').first().click();
    await page.locator('[data-action="lancer"]').click();
    await page.waitForSelector('.toast.ok');
    ok('mission créée depuis l’interface');
    await page.locator('[data-onglet="missions"]').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(dossier, '3-mission-en-cours.png') });
    // Pause / reprise de la simulation
    await page.locator('[data-sim="pause"]').click();
    await page.waitForSelector('[data-sim="reprise"]');
    await page.waitForFunction(() => /Suspendue/.test(document.querySelector('[data-contenu="missions"]')!.textContent!), null, { timeout: 5000 });
    ok('pause de la simulation : mission suspendue');
    await page.locator('[data-sim="reprise"]').click();
    await page.locator('#vitesse').selectOption('8');
    await page.waitForFunction(() => document.querySelector('#kpis')!.textContent!.includes('0Mission en cours'), null, { timeout: 30000 });
    assert.match(await page.locator('[data-contenu="missions"]').innerText(), /Terminée/);
    ok('reprise puis mission terminée (dépôt confirmé)');

    // Camion : arrivée d'un camion vide, puis refus quand plus de poste
    await page.locator('[data-onglet="camions"]').click();
    await page.locator('#form-arrivee [type="submit"]').click();
    await page.waitForSelector('.resultat-arrivee .ok');
    await page.locator('#form-arrivee [type="submit"]').click();
    await page.waitForSelector('.resultat-arrivee p');
    await page.locator('#form-arrivee [type="submit"]').click();
    await page.waitForSelector('.resultat-arrivee .refus');
    assert.match(await page.locator('.resultat-arrivee').innerText(), /aucun poste disponible/);
    ok('arrivée refusée quand tous les postes sont occupés (raison affichée)');
    await page.screenshot({ path: path.join(dossier, '4-camions.png') });

    // Paramètres : vérification de la géométrie
    await page.locator('[data-onglet="parametres"]').click();
    await page.locator('[data-action="verifier"]').click();
    await page.waitForSelector('#verif .carte');
    const v = await page.locator('#verif').innerText();
    assert.match(v, /géométrie valide/i);
    assert.match(v, /49/);
    assert.match(v, /147/);
    assert.match(v, /12,5/);
    assert.match(v, /18,75/);
    ok('paramètres : vérification 49 positions / 147 emplacements / 12,5 et 18,75 mm');
    await page.locator('input[name="grille.nb_positions_x"]').fill('9');
    await page.locator('input[name="grille.espacement_x_mm"]').fill('20');
    await page.locator('[data-action="verifier"]').click();
    await page.waitForSelector('#verif .ko-bord');
    ok('paramètres incohérents : refus expliqué');
    await page.screenshot({ path: path.join(dossier, '5-parametres.png'), fullPage: false });
    await page.locator('[data-onglet="historique"]').click();
    await page.waitForSelector('.journal li');
    await page.screenshot({ path: path.join(dossier, '6-historique.png') });
    assert.deepEqual(erreurs, [], `erreurs console : ${erreurs.join(' | ')}`);
    ok('aucune erreur dans la console du navigateur');
    await page.close();
  }

  // ---------------------------------------------------------- autres tailles d'écran
  for (const [nom, l, h] of [
    ['portable-1366', 1366, 768],
    ['tablette-1024', 1024, 768],
    ['telephone-390', 390, 844],
  ] as const) {
    const { page, erreurs } = await ouvrir(l, h);
    const d = await debordement(page);
    assert.ok(d <= 1, `${nom} : débordement horizontal de ${d}px`);
    await page.screenshot({ path: path.join(dossier, `7-${nom}.png`), fullPage: nom === 'telephone-390' });
    // interaction tactile simple : sélectionner une pile
    await page.locator('.svg-dessus g.case.h1').first().click();
    await page.waitForSelector('[data-contenu="selection"] table');
    assert.deepEqual(erreurs, []);
    ok(`${nom} : pas de débordement horizontal, sélection fonctionnelle`);
    await page.close();
  }

  // ---------------------------------------------------------- coupure du serveur : signalement
  {
    const { page } = await ouvrir(1366, 768);
    await srv.arreter();
    await page.waitForSelector('body.hors-ligne', { timeout: 20000 });
    assert.match(await page.locator('#bandeaux').innerText(), /anciennes|indisponibles|perdue/);
    await page.screenshot({ path: path.join(dossier, '8-deconnexion.png') });
    ok('arrêt du serveur : données signalées anciennes, commandes désactivées');
    await page.close();
  }
} finally {
  await navigateur.close();
  await srv.arreter().catch(() => undefined);
}
console.log(`\n${resultats.length} vérifications d’interface réussies. Captures : ${dossier}`);
process.exit(0);
