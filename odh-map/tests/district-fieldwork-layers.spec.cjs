const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const template = readFileSync(path.join(root, 'work/district_page_template.html'), 'utf8');
let script = template.slice(template.lastIndexOf('<script>') + 8, template.lastIndexOf('</script>'));
script = script.slice(0, script.lastIndexOf('  createMap().catch')) +
  'window.fieldwork={state,renderShootLogin};})();';
script = script.replaceAll('{{DISTRICT}}', 'Дмитровский').replaceAll('{{SLUG}}', 'dmitrovskiy');

for (const width of [390, 1280]) test(`район видит фото тротуаров без правок, ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const html = template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
  await page.route('http://district.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://district.test/');
  await page.addScriptTag({ path: path.join(root, 'districts/sidewalk-shoot-layer.js') });
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const { state } = fieldwork;
    state.photoUser = { role: 'district_editor', district: 'Дмитровский' };
    state.popover = { open() { document.getElementById('card').classList.add('open'); } };
    window.ymaps3 = { YMapMarker: class { constructor(options, element) { this.element = element; } } };
    const map = { addChild(marker) { document.getElementById('map').append(marker.element); }, removeChild(marker) { marker.element.remove(); } };
    state.sidewalkLayer = initSidewalkShootLayer({ map, slug: 'dmitrovskiy', district: 'Дмитровский',
      apiRequest: async url => ({ json: async () => url.endsWith('/slot') ? {} : { points: [{
        id: 'test', point_no: 'Т7.1', address: 'Тестовый дом', heading: 90, longitude: 37.5, latitude: 55.8,
      }] } }), getUser: () => state.photoUser, escapeHtml: value => String(value ?? ''),
      centerSelection() {}, popover: state.popover, preparePointPhoto: async file => file });
    fieldwork.renderShootLogin();
  });
  await expect(page.locator('#sidewalkShootLayer')).toBeVisible();
  await expect(page.locator('#sidewalkShootLayer input')).toBeChecked();
  await page.locator('.sidewalk-shoot').dispatchEvent('click');
  await expect(page.locator('#card [data-sw-photo] input[type=file]')).toHaveCount(1);
  await expect(page.locator('#card [data-sw="delete"]')).toHaveCount(0);
  await page.evaluate(() => { fieldwork.state.photoUser = null; fieldwork.renderShootLogin(); });
  await expect(page.locator('#sidewalkShootLayer')).toBeHidden();
  await expect(page.locator('.sidewalk-shoot')).toHaveCount(0);
  await page.evaluate(() => {
    fieldwork.state.photoUser = { role: 'district_editor', district: 'Сокол' };
    fieldwork.renderShootLogin();
  });
  await expect(page.locator('#sidewalkShootLayer')).toBeHidden();
});
