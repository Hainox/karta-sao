import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(() => {
  sessionStorage.setItem('sao-photo-user', JSON.stringify({ id: 'test', role: 'prefecture_admin', login: 'тест-браузер' }));
  sessionStorage.setItem('sao-photo-token', 'fake');
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('https://hainox.github.io/karta-sao/districts/aeroport.html');
await page.waitForSelector('#shootToggle', { timeout: 30000 });
await page.waitForTimeout(4000);

await page.click('#shootToggle');
await page.waitForTimeout(400);
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 100);
await page.waitForTimeout(500);
const afterFirst = await page.evaluate(() => ({
  preview: document.querySelectorAll('.shoot-marker.preview').length,
  hint: document.getElementById('shootHint').textContent.slice(0, 60),
}));
console.log('клик 1 (превью точки):', JSON.stringify(afterFirst));

await page.mouse.click(box.x + box.width / 2 + 110, box.y + box.height / 2 + 40);
await page.waitForTimeout(900);
const afterSecond = await page.evaluate(() => ({
  preview: document.querySelectorAll('.shoot-marker.preview').length,
  hint: document.getElementById('shootHint').textContent.slice(0, 90),
}));
console.log('клик 2 (сохранение точки):', JSON.stringify(afterSecond));
// Рука теперь видна?
console.log('Рука видна (не hidden):', await page.evaluate(() => !document.getElementById('handToggle').hidden));
await page.click('#handToggle');
await page.waitForTimeout(300);
console.log('Рука активна?', await page.evaluate(() => ({ cls: document.getElementById('map').className, hint: document.getElementById('shootHint').textContent.slice(0, 60) })));
console.log('ошибки:', errors.slice(0, 4));
await browser.close();
