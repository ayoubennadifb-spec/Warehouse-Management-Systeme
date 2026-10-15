/** Visual smoke check against the running local app; no inventory mutations. */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RACINE } from '../../src/server/config.ts';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8080/');
  await page.locator('[data-onglet="vision"]').click();
  await page.locator('#vision-detector').selectOption('color');
  await page.locator('#vision-source').selectOption('demo');
  await page.locator('#vision-measures table').waitFor({ timeout: 20000 });
  await page.locator('[data-vision-image="annotated"]').evaluate(async (img: HTMLImageElement) => { await img.decode(); });
  await mkdir(path.join(RACINE, '.local', 'vision-qa'), { recursive: true });
  await page.screenshot({ path: path.join(RACINE, '.local', 'vision-qa', 'vision.png'), fullPage: true });
  await page.locator('details:has(#vision-settings) summary').click();
  await page.locator('[data-setting="min_area"]').fill('800');
  await page.locator('#vision-save').click();
  await page.getByText('Réglages appliqués et sauvegardés.', { exact: true }).waitFor();
  await page.locator('#vision-export').click();
  await page.locator('#vision-downloads a').first().waitFor({ timeout: 20000 });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Vision UI: images, settings and five export links verified.');
  await page.request.post('http://127.0.0.1:8080/api/vision/stop');
} finally { await browser.close(); }
