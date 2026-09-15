// Проверяет, что карта на странице реально построилась: у Leaflet это плитки,
// у Яндекс JS API — canvas и контейнер карты.
import { chromium } from 'playwright';

const BASE = process.env.ATLAS_BASE || 'https://hainox.github.io/karta-sao';

const PAGES = [
  { path: '/', name: 'дворы и участки (Яндекс API)', engine: 'yandex', ready: ['canvas'] },
  { path: '/smm/', name: 'маршруты СММ (Яндекс API)', engine: 'yandex', ready: ['canvas'] },
  { path: '/object-maps/', name: 'фотофиксация (Яндекс API 2.1)', engine: 'yandex', ready: ['#paLoginInput'] },
  { path: '/odh-map/', name: 'ОДХ (Leaflet + Яндекс-плитки)', engine: 'leaflet', ready: ['.leaflet-container', 'img.leaflet-tile'] },
  { path: '/odh-map/district-editor.html', name: 'редактор района', engine: 'leaflet', ready: ['.leaflet-container', 'img.leaflet-tile'] },
  { path: '/odh-map/district-review.html', name: 'приёмка префектуры', engine: 'leaflet', ready: ['.leaflet-container', 'img.leaflet-tile'] },
  { path: '/yards-print/', name: 'печать дворов A3', engine: 'leaflet', ready: ['.leaflet-container', 'img.leaflet-tile'] },
  { path: '/odh-map/print-a3.html', name: 'печать ОДХ A3', engine: 'leaflet', ready: ['.leaflet-container'] }
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let failures = 0;

for (const spec of PAGES) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).split('\n')[0]));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !/status of 404/.test(text)) errors.push(text);
  });

  let state = { canvas: 0, tiles: 0, tilesLoaded: 0, apiReady: null };
  try {
    await page.goto(`${BASE}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    for (const selector of spec.ready) {
      await page.waitForSelector(selector, { timeout: 45_000 });
    }
    await page.waitForTimeout(10_000);
    state = await page.evaluate(() => ({
      canvas: document.querySelectorAll('canvas').length,
      tiles: document.querySelectorAll('img.leaflet-tile').length,
      tilesLoaded: [...document.querySelectorAll('img.leaflet-tile')].filter((img) => img.naturalWidth > 0).length,
      apiReady: typeof window.ymaps3 !== 'undefined' || typeof window.ymaps !== 'undefined'
    }));
  } catch (error) {
    console.log(`FAIL ${spec.name} :: ${String(error).split('\n')[0]}`);
    failures++;
    await page.close();
    continue;
  }

  let ok = true;
  if (spec.engine === 'yandex') {
    ok = spec.path.includes('object-maps') ? state.apiReady !== null : state.canvas > 0;
  } else {
    ok = state.tiles === 0 ? true : state.tilesLoaded > 0;
  }
  if (errors.length) ok = false;
  if (!ok) failures++;

  console.log(`${ok ? 'ok  ' : 'FAIL'} ${spec.name.padEnd(38)} canvas ${state.canvas}, плиток ${state.tilesLoaded}/${state.tiles}, API ${state.apiReady}${errors.length ? ' :: ' + errors.slice(0, 2).join(' | ') : ''}`);
  await page.close();
}

await browser.close();
console.log(`\nпровалов: ${failures}`);
