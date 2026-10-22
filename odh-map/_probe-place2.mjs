import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(() => {
  sessionStorage.setItem('sao-photo-user', JSON.stringify({ id: 'test', role: 'prefecture_admin', login: 'тест-браузер' }));
  sessionStorage.setItem('sao-photo-token', 'fake');
});
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:8766/districts/aeroport.html');
await page.waitForSelector('#shootToggle', { timeout: 30000 });
await page.waitForTimeout(3500);

await page.locator('#layerControls input:checkbox').uncheck({ force: true }).catch(async () => {
  // force click может не сработать по скрытым чекбоксам — снимаем атрибут напрямую
  await page.evaluate(() => document.querySelectorAll('#layerControls input').forEach((i) => { i.checked = false; i.dispatchEvent(new Event('change')); }));
});
await page.click('#shootToggle');
await page.waitForTimeout(300);
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);
console.log('preview после клика 1:', await page.evaluate(() => document.querySelectorAll('.shoot-marker.preview').length));
console.log('hint:', (await page.evaluate(() => document.getElementById('shootHint').textContent)).slice(0, 90));
await page.mouse.click(box.x + box.width / 2 + 90, box.y + box.height / 2 - 70);
await page.waitForTimeout(800);
console.log('hint после клика 2:', (await page.evaluate(() => document.getElementById('shootHint').textContent)).slice(0, 120));
console.log('ошибки:', errors.slice(0, 4));
await browser.close();
