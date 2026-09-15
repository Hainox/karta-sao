import { chromium } from '@playwright/test';

const STATIC = 'https://hainox.github.io/karta-sao';
const API = 'https://obhod-sao.ru/photo-api';
const LOGIN = process.env.PHOTO_DISTRICT_LOGIN;
const PASSWORD = process.env.PHOTO_DISTRICT_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('Set PHOTO_DISTRICT_LOGIN and PHOTO_DISTRICT_PASSWORD');
  process.exit(2);
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail: String(detail).slice(0, 200) });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ' :: ' + String(detail).slice(0, 160) : ''}`);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(`${STATIC}/object-maps/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pa-dataset', { timeout: 60000 });
  check('страница атласа открывается', true);
  const tabs = await page.locator('.pa-dataset').allTextContents();
  check('видны три набора данных', tabs.length === 3, tabs.join(' / '));

  await page.fill('#paLoginInput', LOGIN);
  await page.fill('#paPasswordInput', PASSWORD);
  await page.click('#paLoginButton');
  await page.waitForFunction(() => document.getElementById('paSessionState').textContent.includes('·'), null, { timeout: 60000 });
  check('вход с домена атласа сохраняет сессию', true, await page.locator('#paSessionState').innerText());

  await page.waitForFunction(() => /%/.test(document.getElementById('paSummary').innerText), null, { timeout: 60000 });
  const summary = await page.locator('#paSummary').innerText();
  check('сводка района загружена из production', /Всего объектов/.test(summary), summary.replace(/\n/g, ' | '));
  check('версия набора видна', (await page.locator('#paSubtitle').innerText()).includes('embedded-map-2026-09-15'), await page.locator('#paSubtitle').innerText());

  const listCount = await page.locator('#paListCount').innerText();
  check('реестр объектов заполнен', /Показано/.test(listCount), listCount);
  check('роль района ограничена своим районом', !/из 812/.test(listCount), listCount);

  /* ---------------------- district: только загрузка, без выгрузок */
  check('у района нет блока выгрузок', await page.locator('#paExports').isHidden(), '');
  check('форма входа скрыта после входа', await page.locator('#paLoginForm').isHidden(), '');
  check('на карте показана граница района', /Показана граница района:/.test(await page.locator('#paBoundaryNote').innerText()), await page.locator('#paBoundaryNote').innerText());

  const districtExport = await page.evaluate(async (api) => {
    const response = await fetch(`${api}/reports/export.xlsx`, { credentials: 'include' });
    return { status: response.status, body: (await response.text()).slice(0, 60) };
  }, API);
  check('сервер отклоняет выгрузку для района', districtExport.status === 403 && /prefecture_role_required/.test(districtExport.body), JSON.stringify(districtExport));

  await page.locator('.pa-row').first().click();
  await page.waitForSelector('#paDialog[open]');
  await page.waitForFunction(() => document.getElementById('paGallery').textContent.trim().length > 0, null, { timeout: 30000 });
  check('карточка объекта открывается', (await page.locator('#paDialogData').innerText()).length > 20);
  check('галерея пустого объекта без ошибки', /нет фотографий/.test(await page.locator('#paGallery').innerText()), await page.locator('#paGallery').innerText());
  check('у района нет ссылки скачивания фото', (await page.locator('#paGallery a.pa-btn').count()) === 0, '');
  await page.keyboard.press('Escape');
  check('Esc закрывает карточку', await page.locator('#paDialog').evaluate((node) => !node.open));

  await page.locator('.pa-dataset').nth(1).click();
  await page.waitForFunction(() => document.getElementById('paTitle').textContent.includes('ПП'), null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.pa-row').length > 0, null, { timeout: 60000 });
  check('переключение набора работает', true);

  await page.click('#paQueueTab');
  await page.waitForFunction(() => document.querySelectorAll('#paQueueCard .pa-queue-title').length > 0, null, { timeout: 60000 });
  check('маршрутная очередь строится', /Осталось/.test(await page.locator('#paQueueProgress').innerText()), await page.locator('#paQueueProgress').innerText());

  const relevantErrors = consoleErrors.filter((text) => !/yandex|ymaps|maps\.yandex|ERR_|Failed to load resource|favicon/i.test(text));
  check('нет ошибок страницы', relevantErrors.length === 0, relevantErrors.join(' | '));

  await context.close();

  /* ------------------------------------------------------- prefecture */
  if (process.env.PHOTO_PREFECTURE_LOGIN && process.env.PHOTO_PREFECTURE_PASSWORD) {
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const admin = await adminContext.newPage();
    const adminErrors = [];
    admin.on('pageerror', (error) => adminErrors.push(String(error)));
    admin.goto(`${STATIC}/object-maps/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await admin.waitForSelector('.pa-dataset');
    await admin.fill('#paLoginInput', process.env.PHOTO_PREFECTURE_LOGIN);
    await admin.fill('#paPasswordInput', process.env.PHOTO_PREFECTURE_PASSWORD);
    await admin.click('#paLoginButton');
    await admin.waitForFunction(() => /%|нет данных/.test(document.getElementById('paSummary').innerText), null, { timeout: 60000 });
    check('вход префектуры на живом домене', true, await admin.locator('#paSessionState').innerText());
    check('у префектуры есть блок выгрузок', await admin.locator('#paExports').isVisible(), '');
    check('префектура видит все границы районов', /Показаны границы всех 16 районов/.test(await admin.locator('#paBoundaryNote').innerText()), await admin.locator('#paBoundaryNote').innerText());
    const adminSummary = await admin.locator('#paSummary').innerText();
    check('префектура видит нераспределённые объекты', /Без района: 7 объектов/.test(adminSummary), '');
    check('в консоли префектуры нет ошибок страницы', adminErrors.length === 0, adminErrors.join(' | '));
    await adminContext.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\nlive checks: ${results.length}, failed: ${failed.length}`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
