/** Read-only smoke test against an already running app; never resets a database. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.ANTISWAY_TEST_URL ?? 'http://127.0.0.1:8080';
const folder = path.resolve(import.meta.dirname, '../../../.local/antisway-verification');
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      writes.push(route.request().url()); await route.abort();
    } else await route.continue();
  });
  await page.goto(base + '/#anti-ballant', { waitUntil: 'domcontentloaded' });
  await page.locator('#sway-results').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#vue3d').isVisible(), false);
  assert.equal(await page.locator('#sway-charts figure').count(), 4);
  assert.equal(await page.locator('#sway-table tbody tr').count(), 4);
  const initial = await page.locator('#sway-kpis').innerText();
  assert.ok(initial.includes('1,42 s'));
  await page.screenshot({ path: path.join(folder, 'desktop.png'), fullPage: true });
  await page.bringToFront();
  await page.locator('#sway-play').click();
  await page.waitForFunction(() => Number((document.querySelector('#sway-seek') as HTMLInputElement).value) > 0.1, null, { timeout: 10000, polling: 100 }).catch(async e => {
    console.log('État lecture', await page.locator('#sway-play').innerText(), await page.locator('#sway-time').innerText(), await page.locator('#sway-status').innerText(), await page.evaluate(() => ({ hidden: document.hidden, rootHidden: (document.querySelector('[data-contenu=antisway]') as HTMLElement).hidden })));
    throw e;
  });
  await page.locator('#sway-play').click();
  await page.locator('#sway-form details summary').click();
  await page.locator('[name=cableErrorPct]').fill('25');
  assert.equal(await page.locator('#sway-json').isDisabled(), true);
  await page.getByRole('button', { name: 'Comparer les mouvements', exact: true }).click();
  assert.notEqual(await page.locator('#sway-kpis').innerText(), initial);
  assert.equal(await page.locator('#sway-json').isEnabled(), true);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#sway-json').click();
  const download = await downloadEvent;
  await download.saveAs(path.join(folder, 'study.json'));
  const csvEvent = page.waitForEvent('download');
  await page.locator('#sway-csv').click();
  await (await csvEvent).saveAs(path.join(folder, 'curves.csv'));
  await page.locator('[data-onglet=selection]').click();
  assert.equal(await page.locator('[data-contenu=antisway]').isVisible(), false);
  assert.equal(await page.locator('#vue3d').isVisible(), true);
  await page.locator('[data-onglet=antisway]').click();
  assert.equal(await page.locator('[name=cableErrorPct]').inputValue(), '25');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#sway-results').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[name=cableErrorPct]').inputValue(), '25');
  await page.locator('#sway-defaults').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(folder, 'mobile.png'), fullPage: true });
  assert.ok(await page.locator('[data-contenu=antisway]').evaluate(el => el.scrollWidth <= el.clientWidth + 2), 'pas de débordement horizontal du laboratoire');
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, [], 'aucune commande envoyée au serveur');
  console.log('Anti-ballant : affichage, animation, paramètres, persistance, navigation et exports vérifiés ; aucune écriture API.');
  await context.close();
} finally { await browser.close(); }
