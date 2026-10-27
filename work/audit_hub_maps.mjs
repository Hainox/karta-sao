// Живой аудит всех страниц атласа на проде: ошибки в консоли, битые запросы,
// загрузилась ли подложка и основные блоки. Ничего не меняет, только смотрит.
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';

const BASE = process.env.ATLAS_BASE || 'https://hainox.github.io/karta-sao';

// Все 16 районных карт проверяются тем же проходом: их набор одинаков, поэтому
// список собирается из каталога, а не дублируется вручную.
const DISTRICT_PAGES = readdirSync(new URL('../districts/', import.meta.url))
  .filter((name) => name.endsWith('.html') && !['index.html', 'review.html', 'acceptance.html'].includes(name))
  .sort()
  .map((name) => ({
    path: `/districts/${name}`,
    name: `район ${name.replace('.html', '')}`,
    expect: ['#map'],
    map: true,
    wait: 5000
  }));

const PAGES = [
  { path: '/hub/', name: 'хаб — каталог карт', expect: ['a.map-card'], map: false },
  { path: '/', name: 'дворы и участки', expect: ['#map'], map: true },
  { path: '/odh-map/', name: 'ОДХ и очередность', expect: ['#map'], map: true },
  { path: '/odh-map/district-links.html', name: 'ссылки районам', expect: ['a', '.district-link-card'], map: false },
  { path: '/odh-map/district-editor.html', name: 'редактор района', expect: ['#map'], map: true },
  { path: '/odh-map/district-review.html', name: 'приёмка префектуры', expect: ['#map'], map: true },
  { path: '/odh-map/prefecture-guide.html', name: 'памятка префектуры', expect: ['body'], map: false },
  { path: '/object-maps/', name: 'фотофиксация', expect: ['#paMap'], map: true },
  { path: '/object-maps/stops.html', name: 'фотофиксация — остановки', expect: ['#paMap'], map: true },
  { path: '/object-maps/pp.html', name: 'фотофиксация — ПП', expect: ['#paMap'], map: true },
  { path: '/object-maps/entrances.html', name: 'фотофиксация — подъезды', expect: ['#paMap'], map: true },
  { path: '/object-maps/tpu-parking.html', name: 'ТПУ и парковки', expect: ['#map'], map: true },
  { path: '/object-maps/tpu-review.html', name: 'кабинет приёмки ТПУ', expect: ['#loginForm'], map: false },
  { path: '/review-cabinet/', name: 'кабинет приёмки фото', expect: ['#loginForm'], map: false },
  { path: '/districts/', name: 'каталог районов', expect: ['a'], map: false },
  { path: '/smm/', name: 'маршруты СММ', expect: ['body'], map: true },
  { path: '/yards-print/', name: 'печать дворов A3', expect: ['#map'], map: true },
  { path: '/yards-print/print-a1.html', name: 'печать дворов A1', expect: ['#map'], map: true },
  { path: '/odh-map/print-a3.html', name: 'печать ОДХ A3', expect: ['#map'], map: true },
  { path: '/odh-map/print-a1.html', name: 'печать ОДХ A1', expect: ['#map'], map: true },
  // Лист 1000×1400 мм на экране шире окна по замыслу — прокрутку не считаем ошибкой.
  { path: '/odh-map/print-1000x1400.html', name: 'лист 1000x1400', expect: ['body'], map: true, overflow: false },
  { path: '/smm/print-a3.html', name: 'печать СММ A3', expect: ['body'], map: false },
  ...DISTRICT_PAGES
];

// Эти ответы ожидаемы: страницы спрашивают сессию и фото до входа. Локально
// фотослужба на проде не пускает origin localhost, поэтому её запросы и CORS-
// сообщения не считаем ошибкой страницы — карту проверяем по отрисовке.
const EXPECTED = /\/photo-api\/auth\/me|\/photo-api\/object-photo-points|\/photo-api\/reports\/summary|\/odh-api\/api\/submissions\?status=submitted|\/api\/object-photo-points/;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(BASE);
const localNoise = (text) => LOCAL && /Failed to load resource|Access to fetch at .* blocked by CORS policy|net::ERR_FAILED/.test(text);
// Отдельная плитка подложки может сорваться по HTTP/2 и перезагрузиться сама:
// страницу считаем рабочей, если хотя бы одна плитка загрузилась (проверка ниже).
const TILE_HOST = /(?:core-renderer|vec|tiles)\.maps\.yandex\.net/;
const TILE_NOISE = (text) => /Failed to load resource: net::ERR_HTTP2_PROTOCOL_ERROR/.test(text);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const problems = [];

async function auditPage(context, spec, viewportName, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  page.on('console', (message) => { if (message.type() === 'error' && !localNoise(message.text()) && !TILE_NOISE(message.text())) consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(String(error).split('\n')[0]));
  page.on('response', (response) => {
    const status = response.status();
    if (status >= 400 && !EXPECTED.test(response.url())) failed.push(`${status} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText || '';
    if (/ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT/.test(reason)) return;
    if (LOCAL && /net::ERR_FAILED|net::ERR_CONNECTION_REFUSED/.test(reason) && EXPECTED.test(request.url())) return;
    if (TILE_HOST.test(request.url()) && /net::ERR_HTTP2_PROTOCOL_ERROR/.test(reason)) return;
    failed.push(`CLIENT ${reason} ${request.url()}`);
  });

  let tiles = { total: 0, loaded: 0 };
  try {
    await page.goto(`${BASE}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    for (const selector of spec.expect) {
      await page.waitForSelector(selector, { timeout: 30_000 });
    }
    if (spec.map) {
      await page.waitForTimeout(spec.wait || 9000);
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
  if (overflow > 8 && spec.overflow !== false) problems.push({ path: spec.path, viewport: viewportName, kind: 'горизонтальная прокрутка', detail: `${overflow} px` });

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
