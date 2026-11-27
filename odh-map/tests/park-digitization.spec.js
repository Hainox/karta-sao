import { test, expect } from '@playwright/test';

const base = 'http://127.0.0.1:8766/districts/hovrino.html';
const parkId = 'b29078a0-a65a-49aa-a08a-a84b21bc0d72';
const frameId = '45b52562-d4e9-41e9-9f46-f117b201d235';
const park = {
  id: parkId, district: 'Ховрино', name: 'Тестовый парк', asu_ids: [],
  registry_status: 'absent_in_source', needs_review: true,
  source_objects: [{ asuIdInExcel: '12345' }],
  geometry_source: 'Исторический контур паспорта АСУ ОДС',
  geometry: { type: 'Polygon', coordinates: [[[37.49, 55.86], [37.5, 55.86], [37.5, 55.87], [37.49, 55.86]]] },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const maps = `
  class Marker {
    constructor(props, element) {
      this.holder = document.createElement('div');
      this.holder.className = 'fake-map-marker';
      this.holder.style.cssText = 'position:absolute;left:57%;top:42%';
      this.holder.append(element);
      this.update(props);
    }
    update(props) { this.holder.style.zIndex = props.zIndex || 0; }
  }
  class Feature {
    constructor(props) { this.props = props; }
  }
  class Listener extends Feature {}
  class StubMap {
    constructor(element) { this.element = element; this.zoom = 18; }
    addChild(child) {
      if (child.holder) this.element.append(child.holder);
      if (child instanceof Listener) {
        const listener = child.props.onClick;
        if (listener) window.testMapClick = (coordinates) => listener(null, { coordinates });
      }
    }
    removeChild(child) { child.holder?.remove(); }
    getContainer() { return this.element; }
    update() {}
  }
  window.ymaps3 = { ready: Promise.resolve(), YMap: StubMap, YMapMarker: Marker, YMapFeature: Feature,
    YMapListener: Listener, YMapDefaultSchemeLayer: Feature, YMapDefaultFeaturesLayer: Feature };
`;

async function setup(page, role, initialPoint = null, failFirstSave = false, localApi = false) {
  const posts = [];
  let point = initialPoint;
  await page.addInitScript(({ role, localApi }) => {
    const suffix = localApi ? ':local' : '';
    sessionStorage.setItem('sao-photo-token' + suffix, 'test-only');
    sessionStorage.setItem('sao-photo-user' + suffix, JSON.stringify({ role, district: 'Ховрино' }));
  }, { role, localApi });
  await page.route('https://api-maps.yandex.ru/**', route => route.fulfill({ contentType: 'application/javascript', body: maps }));
  await page.route(localApi ? 'http://127.0.0.1:8788/**' : 'https://obhod-sao.ru/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (!path.includes('/object-photo-points/parks/')) return route.fulfill({ json: { points: [] } });
    if (path.endsWith('/district')) return route.fulfill({
      json: { parks: [park], points: point ? [point] : [], destinations: [park] },
    });
    if (method === 'POST') {
      const data = request.postDataJSON();
      posts.push(data);
      if (failFirstSave && posts.length === 1) return route.abort();
      point = { id: data.id, parkId: data.parkId, coordinates: data.coordinates, revision: 1,
        slot: { id: frameId, azimuth: data.azimuth, status: 'empty' } };
      return route.fulfill({ status: 201, json: { point } });
    }
    if (method === 'PATCH') {
      const data = request.postDataJSON();
      point = { ...point, coordinates: data.coordinates, revision: 2, slot: { ...point.slot, azimuth: data.azimuth } };
      return route.fulfill({ json: { point } });
    }
    if (method === 'PUT') {
      expect(path).toContain(frameId);
      expect(request.postDataBuffer().length).toBeGreaterThan(0);
      point = { ...point, slot: { ...point.slot, status: 'pending', photoId: 'test-photo' } };
      return route.fulfill({ status: 201, json: { photo: { status: 'pending', id: 'test-photo' } } });
    }
    if (method === 'DELETE') {
      point = null;
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({ body: png, contentType: 'image/png' });
  });
  await page.goto(base + (localApi ? '?photoApi=local' : ''));
  return posts;
}

async function showPark(page) {
  await page.getByLabel(/Оцифровка Парковых территорий/).check();
  await page.getByRole('combobox', { name: 'Парковая территория' }).selectOption(parkId);
}
const clickMap = (page, coords) => page.evaluate(value => window.testMapClick(value), coords);

test('районная карта префектуры: создание, повтор запроса, перенос, азимут и удаление', async ({ page }) => {
  const posts = await setup(page, 'prefecture_admin', null, true, true);
  await page.getByLabel(/Оцифровка Парковых территорий/).check();
  await page.getByRole('button', { name: 'Добавить точку' }).click();
  await expect(page.getByText('Сначала выберите парк.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Парковая территория' }).selectOption(parkId);
  await expect(page.getByText('По списку отсутствует в АСУ ОДС')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить точку' }).click();
  await clickMap(page, [37.496, 55.864]);
  await clickMap(page, [37.497, 55.864]);
  await expect(page.getByLabel('Азимут, °')).toHaveValue('90');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText(/Точка не сохранена/)).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText('Точка сохранена.')).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(posts[0].parkId).toBe(parkId);
  await expect(page.locator('[data-park-point] .shoot-arrow')).toHaveCount(1);

  await page.getByRole('button', { name: 'Перенести на карте' }).click();
  await clickMap(page, [37.497, 55.865]);
  await expect(page.getByText('37.497000, 55.865000')).toBeVisible();
  await page.getByLabel('Азимут, °').fill('137.50');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Фотослот · 137.5°' })).toBeVisible();

  await page.reload();
  await showPark(page);
  await page.locator('[data-park-point]').dispatchEvent('click');
  await expect(page.getByLabel('Азимут, °')).toHaveValue('137.5');
  await expect(page.getByText('37.497000, 55.865000')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Удалить точку' }).click();
  await expect(page.getByText('Точка удалена.')).toBeVisible();
  await expect(page.locator('[data-park-point]')).toHaveCount(0);
});

test('мобильная карта префектуры: фото одного слота', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const initialPoint = { id: '61281fe5-7dc1-4608-9774-208c0491c234', parkId, coordinates: [37.496, 55.864],
    revision: 1, slot: { id: frameId, azimuth: 70, status: 'empty' } };
  await setup(page, 'prefecture_admin', initialPoint);
  await showPark(page);
  await page.locator('[data-park-point]').dispatchEvent('click');
  await expect(page.getByRole('heading', { name: 'Фотослот · 70°' })).toBeVisible();
  await page.locator('#card input[type=file]').setInputFiles({ name: 'park.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#card').getByText('На проверке')).toBeVisible();
  await expect(page.locator('#card').getByAltText('Фото точки съёмки')).toBeVisible();
  const viewport = await page.getByRole('dialog', { name: park.name }).boundingBox();
  expect(viewport.x).toBeGreaterThanOrEqual(0);
  expect(viewport.x + viewport.width).toBeLessThanOrEqual(390);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Удалить точку' }).click();
  await expect(page.getByText('Точка удалена.')).toBeVisible();
  await expect(page.locator('[data-park-point]')).toHaveCount(0);
});

test('принятая парковая точка защищена от удаления', async ({ page }) => {
  const point = { id: '61281fe5-7dc1-4608-9774-208c0491c234', parkId, coordinates: [37.496, 55.864],
    revision: 1, slot: { id: frameId, azimuth: 70, status: 'accepted', photoId: 'accepted-photo' } };
  await setup(page, 'prefecture_admin', point);
  await showPark(page);
  await page.locator('[data-park-point]').dispatchEvent('click');
  await expect(page.locator('#card').getByText('Принято', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Удалить точку' })).toHaveCount(0);
  await expect(page.locator('#card').getByText('Принятую точку нельзя удалить.')).toBeVisible();
});

test('ссылка из приёмки сразу открывает точку и её парк', async ({ page }) => {
  const point = { id: '61281fe5-7dc1-4608-9774-208c0491c234', parkId, coordinates: [37.496, 55.864],
    revision: 1, slot: { id: frameId, azimuth: 70, status: 'empty' } };
  await setup(page, 'prefecture_admin', point);
  await page.goto(base + '?parkPoint=' + point.id);
  await expect(page.getByLabel(/Оцифровка Парковых территорий/)).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Парковая территория' })).toHaveValue(parkId);
  await expect(page.getByRole('heading', { name: 'Фотослот · 70°' })).toBeVisible();
});

for (const role of ['district_editor', 'dpsp_district_editor']) {
  test(`парковый слой скрыт на районной карте для ${role}`, async ({ page }) => {
    const parkRequests = [];
    page.on('request', request => {
      if (request.url().includes('/object-photo-points/parks/')) parkRequests.push(request.url());
    });
    await setup(page, role);
    await expect(page.locator('#yardPathLayer')).toBeVisible();
    await expect(page.locator('#parkDigitizationLayer')).toBeHidden();
    expect(parkRequests).toHaveLength(0);
  });
}
