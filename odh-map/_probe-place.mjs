import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(() => {
  sessionStorage.setItem('sao-photo-user', JSON.stringify({ id: 'test', role: 'prefecture_admin', login: 'тест-браузер' }));
  sessionStorage.setItem('sao-photo-token', 'fake');
});
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + ' |||STACK||| ' + String(e.stack || 'no stack').slice(0, 500)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('https://hainox.github.io/karta-sao/districts/aeroport.html');
await page.waitForSelector('#shootToggle', { timeout: 30000 });
await page.waitForTimeout(4000);

console.log('Рука скрыта до входа?', await page.evaluate(() => document.getElementById('handToggle').hidden));
console.log('Разметка: кликаю...');

await page.click('#shootToggle');
await page.waitForTimeout(300);
console.log('mapClass:', await page.evaluate(() => document.getElementById('map').className));

// Ставим точку: реальный клик по пустому месту карты
const box = await page.locator('#map').boundingBox();
console.log('map box:', JSON.stringify(box));
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(500);
console.log('preview после клика 1:', await page.evaluate(() => document.querySelectorAll('.shoot-marker.preview').length));
console.log('hint:', await page.evaluate(() => document.getElementById('shootHint').textContent.slice(0, 100)));

// второй клик — направление → сохранение (401 от fake токена, но точка локально не появится? serverOk? публичный API работает → serverOk=true → POST уйдёт с fake токеном → 401 → сообщение ошибки)
await page.mouse.click(box.x + box.width / 2 + 80, box.y + box.height / 2 - 60);
await page.waitForTimeout(700);
console.log('hint после клика 2:', await page.evaluate(() => document.getElementById('shootHint').textContent.slice(0, 160)));

console.log('selecting behaviors:', await page.evaluate(() => { const m = document.getElementById('map'); return { cls: m.className, behaviors: typeof window.ymaps3 !== 'undefined' ? 'api ok' : 'no api' }; }));
console.log('errors:', errors.slice(0, 6));
await browser.close();
