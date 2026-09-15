// Проверяет карту СММ так, как ей пользуется человек: переключает вкладку «Карта»
// и смотрит, построилась ли карта и метки дворов.
import { chromium } from 'playwright';

const BASE = process.env.ATLAS_BASE || 'https://hainox.github.io/karta-sao';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (error) => errors.push(String(error).split('\n')[0]));
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error' && !/status of 404/.test(text)) errors.push(text);
});

await page.goto(`${BASE}/smm/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForSelector('#tabMap', { timeout: 30_000 });

const before = await page.evaluate(() => ({
  canvas: document.querySelectorAll('canvas').length,
  mapHidden: document.getElementById('mapWrap').classList.contains('hidden')
}));
console.log('до переключения: canvas', before.canvas, '| блок карты скрыт:', before.mapHidden);

await page.click('#tabMap');
await page.waitForTimeout(12_000);

const after = await page.evaluate(() => ({
  canvas: document.querySelectorAll('canvas').length,
  mapHidden: document.getElementById('mapWrap').classList.contains('hidden'),
  status: document.getElementById('status')?.textContent?.trim().slice(0, 200),
  markers: document.querySelectorAll('#map button').length
}));
const tile = await page.evaluate(() => {
  const canvas = document.querySelector('#map canvas');
  return canvas ? { width: canvas.width, height: canvas.height } : null;
});

console.log('после переключения: canvas', after.canvas, '| блок карты скрыт:', after.mapHidden);
console.log('метки дворов на карте:', after.markers);
console.log('сообщение статуса:', after.status);
console.log('размер canvas:', tile ? `${tile.width}x${tile.height}` : 'нет');
console.log('ошибки страницы:', errors.length ? errors.join(' | ') : 'нет');
console.log((after.canvas > 0 && after.markers >= 5) ? '\nИТОГ: карта работает' : '\nИТОГ: карта не построилась');

await browser.close();
