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

  await page.locator('.pa-row').first().click();
  await page.waitForSelector('#paDialog[open]');
  await page.waitForFunction(() => document.getElementById('paGallery').textContent.trim().length > 0, null, { timeout: 30000 });
  check('карточка объекта открывается', (await page.locator('#paDialogData').innerText()).length > 20);
  check('галерея пустого объекта без ошибки', /нет фотографий/.test(await page.locator('#paGallery').innerText()), await page.locator('#paGallery').innerText());
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
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\nlive checks: ${results.length}, failed: ${failed.length}`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
