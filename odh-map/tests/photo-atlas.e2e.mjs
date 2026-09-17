// Browser check for the atlas photo-fixation page.
//
// It needs a running photo service and a static server for the repository root:
//   docker compose -p sao-photo-service-e2e up -d database photo-service   (photo-service/)
//   node tests/static-server.mjs                                          (odh-map/)
//   node tests/photo-atlas.e2e.mjs
//
// Environment: PHOTO_API_BASE (default http://127.0.0.1:8791), STATIC_BASE (default http://127.0.0.1:8766),
// PHOTO_DISTRICT_LOGIN / PHOTO_DISTRICT_PASSWORD for a district account.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.PHOTO_API_BASE || 'http://127.0.0.1:8791';
const STATIC = process.env.STATIC_BASE || 'http://127.0.0.1:8766';
const LOGIN = process.env.PHOTO_DISTRICT_LOGIN || 'Аэропорт';
const PASSWORD = process.env.PHOTO_DISTRICT_PASSWORD || 'Aeroport2026x';
const SHOTS = process.env.PHOTO_E2E_SHOTS || fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(SHOTS, { recursive: true });

// Smallest valid JPEG; the service checks magic bytes, so it must be a real image.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`FAILED: ${name} ${detail}`);
}

async function login(page) {
  await page.fill('#paLoginInput', LOGIN);
  await page.fill('#paPasswordInput', PASSWORD);
  await page.click('#paLoginButton');
  await page.waitForFunction(() => document.getElementById('paSessionState').textContent.includes('·'), null, { timeout: 20000 });
}

function parseCoordinates(text) {
  const match = /(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(text || '');
  return match ? { latitude: Number(match[1]), longitude: Number(match[2]) } : null;
}

async function step(label, action) {
  try {
    return await action();
  } catch (error) {
    throw new Error(`[${label}] ${error.message}`);
  }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  /* ---------------------------------------------------- desktop: ведомость */
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await desktop.grantPermissions(['geolocation']);
  await desktop.addInitScript(`window.SAO_PHOTO_API_BASE = ${JSON.stringify(API)};`);
  const page = await desktop.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(`${STATIC}/object-maps/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pa-dataset');
  const titles = await page.locator('.pa-dataset').allTextContents();
  check('все три набора доступны на одной странице', titles.length === 3, JSON.stringify(titles));
  check('в наборе видны контрольные количества', titles[0].includes('812') && titles[1].includes('2') && titles[2].includes('10'), JSON.stringify(titles));

  await login(page);
  await page.waitForFunction(() => /%|нет данных/.test(document.getElementById('paSummary').textContent), null, { timeout: 20000 });

  const summaryText = await page.locator('#paSummary').innerText();
  check('сводка показывает процент и текстовую полосу', /%/.test(summaryText) && /(Красный|Жёлтый|Зелёный)/.test(summaryText), summaryText.replace(/\n/g, ' | '));
  check('сводка показывает отдельные счётчики', /На проверке/.test(summaryText) && /Охват/.test(summaryText), '');
  check('версия набора видна в шапке', (await page.locator('#paSubtitle').innerText()).includes('embedded-map-2026-09-15'), await page.locator('#paSubtitle').innerText());

  // A district account is scoped to its own district, so unassigned objects must not leak in.
  check('роль района не видит объекты без района', !/Объектов без района/.test(summaryText), summaryText.replace(/\n/g, ' | '));
  check('форма входа скрыта после входа', await page.locator('#paLoginForm').isHidden(), '');
  check('панель очереди не показана в режиме ведомости', await page.locator('#paQueuePanel').isHidden(), '');
  const districtScoped = await page.locator('#paListCount').innerText();
  check('реестр роли района ограничен своим районом', !/из 812/.test(districtScoped), districtScoped);

  /* -------------------------------------------- district: upload only, no exports */
  check('у района нет блока выгрузок', await page.locator('#paExports').isHidden(), '');
  check('у района нет кнопки Excel', await page.locator('#paExportXlsx').isHidden(), '');
  check('у района нет кнопки PDF', await page.locator('#paExportPdf').isHidden(), '');
  check('у района нет кнопки CSV', await page.locator('#paExportCsv').isHidden(), '');
  check('на карте показана граница своего района', /Показана граница района: Аэропорт/.test(await page.locator('#paBoundaryNote').innerText()), await page.locator('#paBoundaryNote').innerText());

  const districtExport = await step('district-export', () => page.evaluate(async (api) => {
    const results = {};
    for (const path of ['/reports/export.xlsx', '/reports/export.pdf']) {
      const response = await fetch(`${api}${path}`, { credentials: 'include' });
      results[path] = { status: response.status, body: (await response.text()).slice(0, 80) };
    }
    return results;
  }, API));
  check('сервер отклоняет выгрузки для района', districtExport['/reports/export.xlsx'].status === 403 && districtExport['/reports/export.pdf'].status === 403, JSON.stringify(districtExport));
  check('сервер отвечает причиной отказа', /prefecture_role_required/.test(districtExport['/reports/export.xlsx'].body), districtExport['/reports/export.xlsx'].body);

  const rows = page.locator('.pa-row');
  const rowCount = await rows.count();
  check('реестр объектов заполнен для роли района', rowCount > 0, `rows=${rowCount}`);
  const firstRowText = await rows.first().innerText();
  check('у объекта есть текст подтверждения и статус', /подтверждено \d+ из \d+/.test(firstRowText), firstRowText.replace(/\n/g, ' | '));
  await page.screenshot({ path: join(SHOTS, 'desktop-register.png'), fullPage: false });

  /* --------------------------------- correct display of a photo metadata */
  await rows.first().click();
  await page.waitForSelector('#paDialog[open]');
  // The dialog opens before the gallery finishes loading, so wait for its text.
  await page.waitForFunction(() => document.getElementById('paGallery').textContent.trim().length > 0, null, { timeout: 20000 });
  const dialogData = await page.locator('#paDialogData').innerText();
  check('карточка объекта открывается с данными источника', dialogData.length > 20, '');
  check('у пустого объекта галерея сообщает об отсутствии фото', /нет фотографий/.test(await page.locator('#paGallery').innerText()), '');

  const coordinates = parseCoordinates(dialogData);
  check('координаты объекта разобраны из карточки', coordinates !== null, dialogData.slice(0, 120));
  await desktop.setGeolocation({ latitude: coordinates.latitude, longitude: coordinates.longitude, accuracy: 4 });

  /* ------------------------------- upload, lost response, retry, no duplicate */
  await page.setInputFiles('#paFile', { name: 'check.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  await page.click('#paGpsButton');
  // The distance is resolved after the fix arrives, so wait for that line.
  await page.waitForFunction(() => /До объекта/.test(document.getElementById('paGpsNote').textContent), null, { timeout: 20000 });
  check('GPS получен и показан с точностью', /точность около 4 м/.test(await page.locator('#paGpsNote').innerText()), await page.locator('#paGpsNote').innerText());
  check('GPS показывает расстояние до объекта и вердикт', /До объекта [\d\u00a0\s,]+ м — в радиусе 15 м\./.test(await page.locator('#paGpsNote').innerText()), await page.locator('#paGpsNote').innerText());

  check('отправка заблокирована, пока не указан исполнитель', await page.locator('#paSave').isDisabled(), '');
  check('интерфейс объясняет, чего не хватает', /укажите исполнителя/.test(await page.locator('#paLimitNote').innerText()), await page.locator('#paLimitNote').innerText());
  await page.fill('#paPerformer', 'Иванов И.');
  check('после заполнения исполнителя отправка доступна', await page.locator('#paSave').isEnabled(), '');

  // The first attempt reaches the server but the response never comes back, which is
  // exactly the situation that used to create a second photo on retry.
  let dropFirstResponse = true;
  const uploadBodies = [];
  // Match only the upload endpoint itself; a glob pattern would also catch the gallery GET.
  await page.route((url) => url.pathname === '/photos', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    // Read the body once and hand it back explicitly: consuming it twice breaks the replay.
    const text = await response.text();
    uploadBodies.push(JSON.parse(text));
    if (dropFirstResponse) { dropFirstResponse = false; return route.abort('failed'); }
    return route.fulfill({ response, body: text });
  });

  await page.click('#paSave');
  await page.waitForFunction(() => document.getElementById('paUploadState').dataset.state === 'error', null, { timeout: 20000 });
  const errorText = await page.locator('#paUploadState').innerText();
  check('ошибка отправки показана текстом', /Ошибка отправки/.test(errorText), errorText);

  await page.click('#paSave');
  await page.waitForFunction(() => document.getElementById('paUploadState').dataset.state === 'review', null, { timeout: 20000 });
  const sentText = await page.locator('#paUploadState').innerText();
  check('повторная отправка распознана как повтор, а не дубль', /повтор не создал дубль/.test(sentText), sentText);
  check('геопроверка показана словами', /В радиусе 15 м/.test(sentText), sentText);

  await page.waitForFunction(() => document.querySelectorAll('#paGallery .pa-photo').length > 0, null, { timeout: 20000 });
  const caption = await page.locator('#paGallery .pa-photo dl').first().innerText();
  check('подпись фото содержит дату и время', /\d{2}\.\d{2}\.\d{4}/.test(caption) && !/Invalid Date/.test(caption), caption.replace(/\n/g, ' | '));
  check('подпись фото содержит точность GPS и дистанцию', /точность около 4 м/.test(caption) && /Дистанция до точки/.test(caption), '');
  check('подпись фото содержит текстовый геостатус', /В радиусе 15 м/.test(caption), '');
  check('подпись фото содержит статус проверки', /На проверке/.test(caption), '');

  const stored = await step('stored', () => page.evaluate(async (api) => {
    const response = await fetch(`${api}/photos?datasetId=sao_stops&sourceId=${encodeURIComponent(document.getElementById('paDialogSubtitle').textContent.split(' · ').pop())}`, { credentials: 'include' });
    return response.json();
  }, API));
  check('в службе ровно одна фиксация после повторной отправки', stored.photos.length === 1, JSON.stringify(stored.photos.map((photo) => photo.id)));
  check('клиент приложил миниатюру для отчёта', uploadBodies[0]?.thumbnail === true, JSON.stringify(uploadBodies));
  check('у района нет ссылки скачивания фото', (await page.locator('#paGallery .download-photo, #paGallery a.pa-btn').count()) === 0, '');
  check('у района нет доски округа', await page.locator('#paDashboard').isHidden(), '');

  await page.screenshot({ path: join(SHOTS, 'desktop-dialog.png') });
  await page.keyboard.press('Escape');

  /* ------------------------------------------------------ dataset switching */
  await page.locator('.pa-dataset').nth(1).click();
  await page.waitForFunction(() => document.getElementById('paTitle').textContent.includes('ПП'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.pa-row').length > 0, null, { timeout: 30000 });
  check('переключение набора ПП обновляет страницу', (await page.locator('#paTitle').innerText()).includes('ПП'), '');

  const errorsAfter = consoleErrors.filter((text) => !/yandex|ymaps|maps\.yandex|ERR_|Failed to load resource/i.test(text));
  check('в консоли нет ошибок страницы', errorsAfter.length === 0, errorsAfter.join(' | '));

  /* ------------------------------------------------------ mobile: очередь */
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.grantPermissions(['geolocation']);
  await mobile.addInitScript(`window.SAO_PHOTO_API_BASE = ${JSON.stringify(API)};`);
  const phone = await mobile.newPage();
  await phone.goto(`${STATIC}/object-maps/`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('.pa-dataset');
  await login(phone);
  // Sign-in resolves before the summary and the boundary redraw finish.
  await phone.waitForFunction(() => /%|нет данных/.test(document.getElementById('paSummary').innerText), null, { timeout: 30000 });

  /* ------------------------------- mobile: карта первой, список по кнопке */
  const mapBox = await phone.locator('#paMap').boundingBox();
  const viewport = phone.viewportSize();
  check('карта видна без прокрутки', mapBox !== null && mapBox.y < viewport.height && mapBox.height > 300, JSON.stringify(mapBox));
  check('страница не выше экрана', await phone.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2), await phone.evaluate(() => `${document.documentElement.scrollHeight} vs ${window.innerHeight}`));
  check('список скрыт и не мешает карте', await phone.locator('#paSide').isHidden(), '');
  check('кнопка вызова списка видна', await phone.locator('#paPanelToggle').isVisible(), '');
  check('на карте видна граница района', /Показана граница района/.test(await phone.locator('#paBoundaryNote').innerText()), await phone.locator('#paBoundaryNote').innerText());

  await phone.click('#paPanelToggle');
  await phone.waitForFunction(() => document.getElementById('paSide').dataset.open === 'true');
  check('кнопка открывает список поверх карты', await phone.locator('#paSide').isVisible(), '');
  check('в списке есть поиск и фильтры', await phone.locator('#paSearch').isVisible() && await phone.locator('#paStatusFilter').isVisible(), '');
  check('у района в списке нет выгрузок', await phone.locator('#paExports').isHidden(), '');
  await phone.click('#paPanelClose');
  await phone.waitForFunction(() => document.getElementById('paSide').dataset.open === 'false');
  check('кнопка закрывает список', await phone.locator('#paSide').isHidden(), '');
  check('карта снова доступна после закрытия списка', await phone.locator('#paPanelToggle').isVisible(), '');

  await phone.click('#paQueueTab');
  await phone.waitForSelector('#paQueuePanel:not([hidden])');
  await phone.waitForFunction(() => document.querySelectorAll('#paQueueCard .pa-queue-title').length > 0, null, { timeout: 30000 });
  await phone.fill('#paQueuePerformer', 'Петров П.');

  const queueProgress = await phone.locator('#paQueueProgress').innerText();
  check('очередь показывает остаток объектов', /Осталось [\d\s\u00a0]+ объектов/.test(queueProgress), queueProgress);
  const queueCard = await phone.locator('#paQueueCard').innerText();
  check('карточка очереди показывает статус и остаток съёмки', /Осталось снять/.test(queueCard) && /Статус/.test(queueCard), '');
  check('кнопка съёмки доступна на телефоне', await phone.locator('label[for="paQueueFile"]').isVisible(), '');
  check('нет горизонтальной прокрутки', await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), '');

  // A standalone mobile scenario needs usable targets and readable text, not just no overflow.
  const mobileLayout = await phone.evaluate(() => {
    const camera = document.querySelector('label[for="paQueueFile"]').getBoundingClientRect();
    const send = document.getElementById('paQueueSave').getBoundingClientRect();
    const title = getComputedStyle(document.querySelector('.pa-queue-title'));
    const state = getComputedStyle(document.getElementById('paQueueState'));
    return {
      cameraHeight: camera.height, sendHeight: send.height,
      titleFont: parseFloat(title.fontSize), stateFont: parseFloat(state.fontSize),
    };
  });
  check('кнопка съёмки не меньше 44 px по высоте', mobileLayout.cameraHeight >= 44, JSON.stringify(mobileLayout));
  check('кнопка отправки не меньше 44 px по высоте', mobileLayout.sendHeight >= 44, JSON.stringify(mobileLayout));
  check('текст мобильного сценария крупный', mobileLayout.titleFont >= 18 && mobileLayout.stateFont >= 16, JSON.stringify(mobileLayout));
  await phone.screenshot({ path: join(SHOTS, 'mobile-queue.png'), fullPage: false });

  /* ----------------------------------------------------------- atlas entry */
  const hub = await desktop.newPage();
  await hub.goto(`${STATIC}/hub/`, { waitUntil: 'domcontentloaded' });
  const photoCard = hub.locator('#object-photo-maps a.map-card');
  check('в атласе ровно одна карточка фотофиксации', (await photoCard.count()) === 1, String(await photoCard.count()));
  check('карточка ведёт на отдельную страницу атласа', (await photoCard.getAttribute('href')) === '../object-maps/', String(await photoCard.getAttribute('href')));

  /* --------------------------------------------------- prefecture: весь САО */
  const prefecture = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prefecture.addInitScript(`window.SAO_PHOTO_API_BASE = ${JSON.stringify(API)};`);
  const admin = await prefecture.newPage();
  await admin.goto(`${STATIC}/object-maps/`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('.pa-dataset');
  await admin.fill('#paLoginInput', 'Префектура');
  await admin.fill('#paPasswordInput', 'Prefektura2026x');
  await admin.click('#paLoginButton');
  await admin.waitForFunction(() => /%|нет данных/.test(document.getElementById('paSummary').textContent), null, { timeout: 30000 });

  const adminSummary = await admin.locator('#paSummary').innerText();
  check('префектура видит объекты без района отдельной пометкой', /Объектов без района: 7/.test(adminSummary), adminSummary.replace(/\n/g, ' | '));
  check('префектуре доступен выбор района', await admin.locator('#paDistrictFilter').isEnabled(), '');
  // Объекты без района входят в сводку САО: они учтены в строке «АвД САО».
  check('сводка САО считает весь набор объектов', /Всего объектов\n11\s?275/.test(adminSummary), adminSummary.replace(/\n/g, ' | '));
  check('пометка объясняет, где учтены объекты без района', /учтены в строке «АвД САО»/.test(adminSummary), '');

  /* ------------------------------------------- дашборд округа у префектуры */
  const board = admin.locator('#paDistrictBoard .pa-board-row');
  check('префектура видит доску районов', await admin.locator('#paDashboard').isVisible(), '');
  check('на доске все районы и строка АвД', (await board.count()) === 18, String(await board.count()));
  check('«АвД САО» замыкает доску', /АвД САО/.test(await board.last().innerText()), await board.last().innerText().then((text) => text.replace(/\n/g, ' | ')));
  const firstBoardRow = await board.first().innerText();
  check('в строке района есть доля и процент', /из \d+ объектов/.test(firstBoardRow) && /%/.test(firstBoardRow), firstBoardRow.replace(/\n/g, ' | '));
  check('у «АвД САО» нет кнопки перехода', (await admin.locator('#paDistrictBoard div.pa-board-row').count()) === 1, '');

  const firstBoardDistrict = firstBoardRow.split('\n')[0];
  await board.first().click();
  await admin.waitForFunction((name) => document.getElementById('paDistrictFilter').value === name, firstBoardDistrict, { timeout: 30000 });
  check('клик по району на доске фильтрует панель', (await admin.locator('#paDistrictFilter').inputValue()) === firstBoardDistrict, firstBoardDistrict);
  check('доска остаётся видимой внутри одного района', await admin.locator('#paDashboard').isVisible(), '');
  await admin.selectOption('#paDistrictFilter', '');
  await admin.waitForFunction(() => /Всего объектов\n11\s?268/.test(document.getElementById('paSummary').innerText), null, { timeout: 30000 });

  await admin.selectOption('#paDistrictFilter', 'Аэропорт');
  await admin.waitForFunction(() => /Всего объектов\n952/.test(document.getElementById('paSummary').innerText), null, { timeout: 30000 });
  check('выбор района пересчитывает сводку', /Всего объектов\n952/.test(await admin.locator('#paSummary').innerText()), '');
  check('по умолчанию фильтр не приписывает объекты району', await admin.locator('#paDistrictFilter').inputValue() === 'Аэропорт', '');
  check('у префектуры показана граница выбранного района', /Показана граница района: Аэропорт/.test(await admin.locator('#paBoundaryNote').innerText()), await admin.locator('#paBoundaryNote').innerText());

  /* ------------------------------------------------ prefecture: exports work */
  await admin.selectOption('#paDistrictFilter', '');
  await admin.waitForFunction(() => /Всего объектов\n11\s?268/.test(document.getElementById('paSummary').innerText), null, { timeout: 30000 });
  check('у префектуры есть блок выгрузок', await admin.locator('#paExports').isVisible(), '');
  check('префектура видит все границы районов', /Показаны границы всех 16 районов/.test(await admin.locator('#paBoundaryNote').innerText()), await admin.locator('#paBoundaryNote').innerText());

  // Левобережный разрезан водохранилищем на две части — проверяем, что MultiPolygon рисуется.
  await admin.selectOption('#paDistrictFilter', 'Левобережный');
  await admin.waitForFunction(() => /Левобережный/.test(document.getElementById('paBoundaryNote').innerText), null, { timeout: 30000 });
  check('район, разрезанный водой, показывается без ошибок', /Показана граница района: Левобережный/.test(await admin.locator('#paBoundaryNote').innerText()), await admin.locator('#paBoundaryNote').innerText());
  await admin.selectOption('#paDistrictFilter', '');

  const exportCheck = await step('export-xlsx', () => admin.evaluate(async (api) => {
    const response = await fetch(`${api}/reports/export.xlsx`, { credentials: 'include' });
    const buffer = await response.arrayBuffer();
    const head = new Uint8Array(buffer).subarray(0, 2);
    return { status: response.status, bytes: buffer.byteLength, zip: head[0] === 0x50 && head[1] === 0x4b };
  }, API));
  check('Excel-выгрузка отдаётся префектуре как рабочий xlsx', exportCheck.status === 200 && exportCheck.zip && exportCheck.bytes > 5000, JSON.stringify(exportCheck));

  const pdfCheck = await step('export-pdf', () => admin.evaluate(async (api) => {
    const response = await fetch(`${api}/reports/export.pdf`, { credentials: 'include' });
    const buffer = await response.arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(buffer).subarray(0, 5));
    return { status: response.status, bytes: buffer.byteLength, pdf: head === '%PDF-' };
  }, API));
  check('PDF-сводка отдаётся префектуре как рабочий pdf', pdfCheck.status === 200 && pdfCheck.pdf, JSON.stringify(pdfCheck));

  await desktop.close();
  await mobile.close();
  await prefecture.close();

  console.log(JSON.stringify({ passed: results.length, checks: results }, null, 2));
} finally {
  await browser.close();
}
