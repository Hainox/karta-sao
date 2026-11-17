const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(path.resolve('odh-map/node_modules/@playwright/test'));

const qa = __dirname;
const fixture = fs.readFileSync(path.join(qa, 'QA-035-test.png'));
const pointId = '03500000-2026-4116-8116-000000000001';
const site = { point_id: pointId, source_id: 'QA-035', address: 'Тестовая площадка · адрес для проверки', district: 'Аэропорт', kind: 'dp' };
const item = { id: 'maf-fixture-1', type_code: 'bench', type_label: 'Скамья', quantity: 1, condition: 'ok', comment: 'Тестовая карточка МАФ', photo_id: 'maf-fixture-1' };
const server = spawn(process.execPath, ['tests/static-server.mjs'], { cwd: path.resolve('odh-map'), windowsHide: true, stdio: 'ignore' });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch('http://127.0.0.1:8766/dp-sp-cabinet/')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Local static server did not start on port 8766');
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  const checks = [];
  try {
    await waitForServer();
    for (const width of [360, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      await context.addInitScript(() => localStorage.setItem('saoPhotoToken', 'mock-only-token'));
      const page = await context.newPage();
      page.on('console', message => { if (message.type() === 'error') errors.push(`capture-${width}: console ${message.text()}`); });
      page.on('pageerror', error => errors.push(`capture-${width}: pageerror ${error.message}`));
      await page.route('https://obhod-sao.ru/photo-api/**', async route => {
        const endpoint = new URL(route.request().url()).pathname.replace(/^\/photo-api/, '');
        if (endpoint === '/auth/me') return route.fulfill({ json: { user: { role: 'prefecture_admin', displayName: 'Тест' } } });
        if (endpoint.endsWith('/dictionaries')) return route.fulfill({ json: { types: [{ code: 'bench', label: 'Скамья' }], districts: [{ name: 'Аэропорт' }] } });
        if (endpoint.endsWith('/workflow/sites')) return route.fulfill({ json: { sites: [site] } });
        if (endpoint.endsWith(`/workflow/sites/${pointId}/photos/overview`)) return route.fulfill({ contentType: 'image/png', body: fixture });
        if (endpoint.endsWith(`/workflow/maf/${item.id}/photo`)) return route.fulfill({ contentType: 'image/png', body: fixture });
        if (endpoint.endsWith(`/workflow/sites/${pointId}`)) return route.fulfill({ json: { photos: [{ id: 'overview', photo_filename: 'QA-035-test.png' }], workflow: null } });
        if (endpoint.endsWith(`/sites/${pointId}`)) return route.fulfill({ json: { site, items: [item] } });
        return route.fulfill({ status: 404, json: { error: `Unmocked API: ${endpoint}` } });
      });
      await page.goto('http://127.0.0.1:8766/dp-sp-cabinet/');
      await page.locator('.item').click();
      await page.locator('#detail h2').waitFor({ state: 'visible' });
      await page.locator('.site-image').evaluate(img => img.decode());
      await page.locator('.maf-photo').evaluate(img => img.decode());
      const layout = await page.evaluate(() => {
        const input = document.querySelector('#detail .buttons input[type="file"]');
        const box = input.getBoundingClientRect();
        const button = getComputedStyle(input, '::file-selector-button');
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          inputHeight: box.height,
          buttonHeight: Number.parseFloat(button.height),
          buttonMinHeight: Number.parseFloat(button.minHeight)
        };
      });
      checks.push(`capture-${width}: file input ${layout.inputHeight}px; file-selector-button ${layout.buttonHeight}px (min ${layout.buttonMinHeight}px); document ${layout.document}/${layout.viewport}px`);
      if (width < 761 && (layout.inputHeight < 44 || layout.buttonHeight < 44 || layout.document > layout.viewport)) {
        throw new Error(`File picker or overflow check failed: ${JSON.stringify(layout)}`);
      }
      if (width === 390) await page.screenshot({ path: path.join(qa, 'capture-card-390.png'), fullPage: true });
      if (width === 1280) await page.screenshot({ path: path.join(qa, 'capture-card-1280.png'), fullPage: true });
      if (width !== 360) {
        for (const [selector, label] of [['.site-image', 'overview'], ['.maf-photo', 'MAF']]) {
          const photo = page.locator(selector);
          await photo.focus(); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('#viewer').open);
          await page.locator('#closeViewer').click();
          const returned = await page.evaluate(selector => document.activeElement === document.querySelector(selector), selector);
          checks.push(`capture-${width}: ${label} focus returned=${returned}`);
          if (!returned) throw new Error(`${label} focus did not return at ${width}px`);
        }
      }
      await context.close();
    }
    const sizes = [];
    for (const name of ['capture-card-390.png', 'capture-card-1280.png', 'review-card-390.png', 'review-card-1280.png']) {
      const image = fs.readFileSync(path.join(qa, name));
      sizes.push(`${name}: ${image.readUInt32BE(16)}x${image.readUInt32BE(20)}`);
    }
    fs.writeFileSync(path.join(qa, 'browser-checks.txt'), [
      `Fixture: ${path.join(qa, 'QA-035-test.png')}`,
      'Workflow: capture=work state; API uses local Playwright mocks only',
      `Console/page errors: ${errors.length}`,
      ...errors,
      ...checks,
      ...sizes,
      'Review screenshots retained from the prior final capture; their UI has no file picker.'
    ].join('\n') + '\n');
    if (errors.length) throw new Error(errors.join(' | '));
  } finally {
    await browser.close(); server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
