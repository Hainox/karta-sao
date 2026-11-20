const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const template = readFileSync(path.join(root, 'work/district_page_template.html'), 'utf8');
test('Оцифровка ДТС сразу показывает единственную стрелку и фотослот каждой точки', async ({ page }) => {
  await page.setContent('<div id="map"></div><div id="sidewalkShootLayer"></div><div id="card"></div>');
  await page.addStyleTag({ path: path.join(root, 'districts/point-popover.css') });
  await page.addScriptTag({ path: path.join(root, 'districts/sidewalk-shoot-layer.js') });
  await page.evaluate(() => {
    window.ymaps3 = { YMapMarker: class {
      constructor(options, element) { this.element = element; }
      update() {}
    } };
    const points = [0, 90].map((azimuth, index) => ({
      id: 'DTS-' + index, district: 'Аэропорт', coordinates: [37.51 + index / 100, 55.8],
      sourceId: 'asu', street: 'Дорожка', slots: [{ id: 'frame-' + index, azimuth }],
    }));
    initSidewalkShootLayer({
      map: { addChild(m) { document.getElementById('map').append(m.element); }, removeChild(m) { m.element.remove(); } },
      district: 'Аэропорт', centerSelection() {}, popover: { open() {}, setHeading() {} },
      getUser: () => ({ role: 'district_editor', district: 'Аэропорт' }),
      apiRequest: async () => ({ json: async () => ({ points }) }),
    }).setVisible(true);
  });
  await page.getByLabel(/Оцифровка ДТС/).check();
  await expect(page.locator('#map .shoot-arrow')).toHaveCount(2);
  for (const index of [0, 1, 0]) {
    await page.locator('#map .shoot-marker').nth(index).dispatchEvent('click');
    await expect(page.getByRole('status').filter({ hasText: 'Кадр frame-' + index })).toBeVisible();
    await expect(page.locator('#card input[type=file]')).toHaveCount(1);
    await expect(page.locator('#card .pin-actions[hidden]')).toBeHidden({ timeout: 1500 });
    await expect(page.locator('#map .shoot-arrow')).toHaveCount(2);
  }
});
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

for (const [layer, width] of [['yardPathLayer', 1280], ['yardPathLayer', 390], ['sidewalkTestLayer', 1280]]) {
  test(`карточка ${layer} не закрывает ручку поворота на экране шириной ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 620 });
    await page.setContent('<div id="map" style="position:fixed;inset:0"></div><div id="sidewalkShootLayer" hidden></div><div id="card"></div>');
    await page.addStyleTag({ path: path.join(root, 'districts/point-popover.css') });
    for (const file of ['point-popover.js', 'point-editor.js', 'sidewalk-shoot-layer.js']) {
      await page.addScriptTag({ path: path.join(root, 'districts', file) });
    }
    await page.evaluate(() => {
      const mapElement = document.getElementById('map');
      const center = [37.5, 55.8];
      const zoom = 18;
      const pixelsPerDegree = 2 ** zoom * 111320 / 156543.03;
      const latitudeScale = pixelsPerDegree / Math.cos(center[1] * Math.PI / 180);
      const screenY = innerWidth <= 720 ? 330 : 200;
      const unproject = (x, y) => [center[0] + (x - innerWidth / 2) / pixelsPerDegree, center[1] - (y - screenY) / latitudeScale];
      window.ymaps3 = { YMapMarker: class {
        constructor(options, element) {
          this.holder = document.createElement('div');
          this.holder.style.position = 'absolute';
          this.holder.append(element);
          this.update(options);
          if (element.classList.contains('rot-knob')) {
            element.addEventListener('pointerdown', event => {
              element.setPointerCapture(event.pointerId);
              this.options.onDragStart();
            });
            element.addEventListener('pointermove', event => {
              if (element.hasPointerCapture(event.pointerId)) this.options.onDragMove(unproject(event.clientX, event.clientY));
            });
            element.addEventListener('pointerup', event => this.options.onDragEnd(unproject(event.clientX, event.clientY)));
          }
        }
        update(options) {
          this.options = { ...this.options, ...options };
          const [lng, lat] = this.options.coordinates;
          this.holder.style.left = (innerWidth / 2 + (lng - center[0]) * pixelsPerDegree) + 'px';
          this.holder.style.top = (screenY - (lat - center[1]) * latitudeScale) + 'px';
          this.holder.style.zIndex = String(this.options.zIndex || 0);
        }
      } };
      const map = {
        zoom,
        addChild(marker) { mapElement.append(marker.holder); },
        removeChild(marker) { marker.holder.remove(); },
      };
      const popover = createPointPopover({ map, card: document.getElementById('card'), mapElement });
      const editor = createPointEditor({ map, popover });
      const point = {
        id: 'Y2-00386', district: 'Аэропорт', street: 'Тестовая улица', coordinates: center,
        slots: [{ id: 'first', azimuth: 324 }, { id: 'second', azimuth: 180 }],
      };
      window.savedDirections = [];
      initSidewalkShootLayer({
        map, district: 'Аэропорт', popover, editor,
        getUser: () => ({ role: 'prefecture_admin' }),
        centerSelection() {},
        apiRequest: async (url, options) => ({
          async json() {
            if (options?.method !== 'PATCH') return { points: [point] };
            const change = JSON.parse(options.body);
            window.savedDirections.push({ ...change, url });
            return { point: { ...point, slots: point.slots.map(slot => slot.id === change.slotId ? { ...slot, azimuth: change.azimuth } : slot) } };
          },
        }),
      }).setVisible(true);
    });
    await page.locator('#' + layer + ' input[type=checkbox]').evaluate(input => {
      input.checked = true;
      input.dispatchEvent(new Event('change'));
    });
    await page.locator('.shoot-marker').click();
    await page.getByRole('button', { name: /Фотослот 2/ }).click();
    const knob = page.getByRole('button', { name: 'Повернуть направление кадра' });
    await expect(knob).toBeVisible();
    await expect.poll(() => knob.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    })).toBe(true);
    const rect = await knob.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(width / 2 + 72, width <= 720 ? 330 : 200);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.savedDirections)).toEqual([{
      slotId: 'second',
      azimuth: 90,
      url: '/object-photo-points/' + (layer === 'yardPathLayer' ? 'yard-paths' : 'sidewalk-test') + '/Y2-00386',
    }]);
    await expect(page.getByRole('button', { name: /Фотослот 2 · 90°/ })).toBeVisible();
  });
}
