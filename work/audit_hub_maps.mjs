// Живой аудит всех страниц атласа на проде: ошибки в консоли, битые запросы,
// загрузилась ли подложка и основные блоки. Ничего не меняет, только смотрит.
import { chromium } from 'playwright';

const BASE = process.env.ATLAS_BASE || 'https://hainox.github.io/karta-sao';

const PAGES = [
  { path: '/hub/', name: 'хаб — каталог карт', expect: ['a.map-card'], map: false },
  { path: '/', name: 'дворы и участки', expect: ['#map'], map: true },
  { path: '/odh-map/', name: 'ОДХ и очередность', expect: ['#map'], map: true },
  { path: '/odh-map/district-links.html', name: 'ссылки районам', expect: ['a', '.district'], map: false },
  { path: '/odh-map/district-editor.html', name: 'редактор района', expect: ['#map'], map: true },
  { path: '/odh-map/district-review.html', name: 'приёмка префектуры', expect: ['#map'], map: true },
  { path: '/odh-map/prefecture-guide.html', name: 'памятка префектуры', expect: ['body'], map: false },
  { path: '/object-maps/', name: 'фотофиксация', expect: ['#map'], map: true },
  { path: '/object-maps/stops.html', name: 'фотофиксация — остановки', expect: ['#map'], map: true },
  { path: '/object-maps/pp.html', name: 'фотофиксация — ПП', expect: ['#map'], map: true },
  { path: '/object-maps/entrances.html', name: 'фотофиксация — подъезды', expect: ['#map'], map: true },
  { path: '/smm/', name: 'маршруты СММ', expect: ['body'], map: true },
  { path: '/yards-print/', name: 'печать дворов A3', expect: ['#map'], map: true },
  { path: '/yards-print/print-a1.html', name: 'печать дворов A1', expect: ['#map'], map: true },
  { path: '/odh-map/print-a3.html', name: 'печать ОДХ A3', expect: ['#map'], map: true },
  { path: '/odh-map/print-a1.html', name: 'печать ОДХ A1', expect: ['#map'], map: true },
  { path: '/odh-map/print-1000x1400.html', name: 'лист 1000x1400', expect: ['body'], map: true },
  { path: '/smm/print-a3.html', name: 'печать СММ A3', expect: ['body'], map: false }
];

// Эти ответы ожидаемы: страницы спрашивают сессию до входа.
const EXPECTED = /\/photo-api\/auth\/me|\/odh-api\/api\/submissions\?status=submitted|\/photo-api\/reports\/summary/;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const problems = [];

async function auditPage(context, spec, viewportName, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(String(error).split('\n')[0]));
  page.on('response', (response) => {
    const status = response.status();
    if (status >= 400 && !EXPECTED.test(response.url())) failed.push(`${status} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText || '';
    if (!/ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT/.test(reason)) failed.push(`CLIENT ${reason} ${request.url()}`);
  });

  let tiles = { total: 0, loaded: 0 };
  try {
    await page.goto(`${BASE}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    for (const selector of spec.expect) {
      await page.waitForSelector(selector, { timeout: 30_000 });
    }
    if (spec.map) {
      await page.waitForTimeout(9000);
      tiles = await page.evaluate(() => {
        const images = [...document.querySelectorAll('img')].filter((img) =>
          /yandex|cartocdn|tile|osm|static-maps/i.test(img.src));
        return {
          total: images.length,
          loaded: images.filter((img) => img.naturalWidth > 0).length
        };
      });
    } else {
      await page.waitForTimeout(2000);
    }
  } catch (error) {
    problems.push({ path: spec.path, viewport: viewportName, kind: 'не открылась', detail: String(error).split('\n')[0] });
    await page.close();
    return;
  }

  const visible = await page.evaluate(() => document.body.innerText.trim().length);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  if (pageErrors.length) problems.push({ path: spec.path, viewport: viewportName, kind: 'ошибка JS', detail: pageErrors.join(' | ') });
  if (consoleErrors.length) problems.push({ path: spec.path, viewport: viewportName, kind: 'консоль', detail: consoleErrors.slice(0, 4).join(' | ') });
  if (failed.length) problems.push({ path: spec.path, viewport: viewportName, kind: 'битые запросы', detail: failed.slice(0, 5).join(' | ') });
  if (spec.map && tiles.total > 0 && tiles.loaded === 0) problems.push({ path: spec.path, viewport: viewportName, kind: 'подложка', detail: `ни одна из ${tiles.total} плиток не загрузилась` });
  if (visible < 40) problems.push({ path: spec.path, viewport: viewportName, kind: 'пустая страница', detail: `${visible} символов` });
  if (overflow > 8) problems.push({ path: spec.path, viewport: viewportName, kind: 'горизонтальная прокрутка', detail: `${overflow} px` });

  console.log(`${problems.some((p) => p.path === spec.path && p.viewport === viewportName) ? 'FAIL' : 'ok  '} ${viewportName.padEnd(9)} ${spec.path.padEnd(34)} плитки ${tiles.loaded}/${tiles.total}`);
  await page.close();
}

for (const viewport of [{ name: 'desktop', size: { width: 1440, height: 900 } }, { name: 'мобильный', size: { width: 390, height: 844 } }]) {
  const context = await browser.newContext({ viewport: viewport.size });
  for (const spec of PAGES) {
    if (viewport.name === 'мобильный' && spec.path.includes('/print-')) continue;
    await auditPage(context, spec, viewport.name, viewport.size);
  }
  await context.close();
}

await browser.close();

console.log('\n=== найденные проблемы ===');
if (!problems.length) {
  console.log('нет');
} else {
  for (const problem of problems) {
    console.log(`[${problem.viewport}] ${problem.path} — ${problem.kind}\n    ${problem.detail}`);
  }
}
console.log(`\nпроверено страниц: ${PAGES.length} на двух разрешениях; проблем: ${problems.length}`);
