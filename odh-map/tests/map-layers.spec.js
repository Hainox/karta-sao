// Панель слоёв главной карты: отдельные слои ОДХ и дворов, типы маршрутов районов
// и галочка группы. Карта рисует векторы на canvas, поэтому «нарисовано ли» читаем
// по счётчику «На карте сейчас» — он считается по самим слоям карты, а не по
// галочкам, и потому честно показывает, что переключатель сработал.
import { expect, test } from './fixtures.js';

const baseURL = 'http://127.0.0.1:8766/odh-map/';
const testApi = 'https://api.test/odh';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
};

const YARDS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { district: 'Аэропорт', name: 'ДТ Коптевский М. пр. 4', color: '#ce3622' },
      geometry: { type: 'Polygon', coordinates: [[[37.53, 55.82], [37.531, 55.82], [37.531, 55.821], [37.53, 55.821], [37.53, 55.82]]] }
    },
    {
      type: 'Feature',
      properties: { district: 'Аэропорт', name: 'ДТ Ленинградский пр. 7', color: '#2f8f4f' },
      geometry: { type: 'Polygon', coordinates: [[[37.535, 55.825], [37.536, 55.825], [37.536, 55.826], [37.535, 55.826], [37.535, 55.825]]] }
    }
  ]
};

// Набор района с объектами разных типов: два маршрута, точка и зона.
const SUBMISSIONS = [
  {
    id: 'set-1',
    district: 'Аэропорт',
    status: 'submitted',
    submitted_at: '2026-09-17T06:30:00.000Z',
    change_set: {
      features: [
        { type: 'Feature', properties: { object_no: 1, change_type: 'queue', queue_priority: '1', address: 'Маршрут уборки Аэропорта', district: 'Аэропорт' }, geometry: { type: 'LineString', coordinates: [[37.528, 55.818], [37.538, 55.828]] } },
        { type: 'Feature', properties: { object_no: 2, change_type: 'rotor_transfer', address: 'Перекидка Аэропорта', district: 'Аэропорт' }, geometry: { type: 'LineString', coordinates: [[37.532, 55.822], [37.542, 55.832]] } },
        { type: 'Feature', properties: { object_no: 3, change_type: 'pgm', address: 'Площадка ПГМ', district: 'Аэропорт' }, geometry: { type: 'Point', coordinates: [37.534, 55.824] } },
        { type: 'Feature', properties: { object_no: 4, change_type: 'rotor_snow_storage_zone', address: 'Зона роторного снега', district: 'Аэропорт' }, geometry: { type: 'Polygon', coordinates: [[[37.54, 55.83], [37.541, 55.83], [37.541, 55.831], [37.54, 55.831], [37.54, 55.83]]] } }
      ]
    }
  }
];

async function stubApi(page) {
  await page.route('https://api.test/**', (route) => {
    const url = route.request().url();
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }
    if (url.endsWith('/api/auth/login')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'test-token', user: { email: 'префектура', role: 'prefecture_admin' } })
      });
    }
    if (url.endsWith('/api/submissions/stats')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({
          sets: { total: 1, submitted: 1, approved: 0, rejected: 0 },
          objects: { total: 4, submitted: 4, approved: 0, rejected: 0 },
          lastDistrict: 'Аэропорт',
          lastSubmittedAt: '2026-09-17T06:30:00.000Z',
          checkedAt: '2026-09-17T09:00:00.000Z'
        })
      });
    }
    if (url.endsWith('/api/submissions')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ submissions: SUBMISSIONS })
      });
    }
    return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{}' });
  });
}

async function loginAsPrefecture(page) {
  await page.locator('#routes-api-base').fill(testApi);
  await page.locator('#routes-api-email').fill('префектура');
  await page.locator('#routes-api-password').fill('test-password');
  await page.locator('#routes-login').click();
}

async function shownLayers(page) {
  return Number(await page.locator('#layer-shown').textContent());
}

/** Слои приходят асинхронно: ждём, пока карта их нарисует. */
async function waitForLayers(page) {
  await expect(page.locator('#layer-count')).toHaveText('12');
  await expect(page.locator('#layer-shown')).not.toHaveText('0');
}

test('панель разводит ОДХ, дворы и типы маршрутов районов', async ({ page }) => {
  await page.goto(baseURL);
  await expect(page.locator('#layers-panel .layer-group')).toHaveCount(4);
  await expect(page.locator('#layers-panel')).toContainText('ОДХ и объекты');
  await expect(page.locator('#layers-panel')).toContainText('Дворы');
  await expect(page.locator('#layers-panel')).toContainText('Маршруты районов');
  await expect(page.locator('#layers-panel')).toContainText('Зоны и точки районов');
  await expect(page.locator('[data-key="yards"]')).toBeVisible();
  await expect(page.locator('[data-district-type]')).toHaveCount(6);
  // Объектов районов ещё нет: типы ждут входа префектуры и загрузки.
  await expect(page.locator('[data-district-type="queue"]')).toBeDisabled();
  await expect(page.locator('#district-types-hint')).toContainText('после входа префектуры');
  // До входа районов счётчик считает только слои ОДХ.
  await waitForLayers(page);
  await expect(page.locator('#layer-count')).toHaveText('12');
  expect(await shownLayers(page)).toBeGreaterThan(0);
});

test('объекты районов рисуются по типам, и каждый тип скрывается отдельно', async ({ page }) => {
  await stubApi(page);
  await page.goto(baseURL);
  await loginAsPrefecture(page);

  // Типов без объектов в наборе на карте нет: слои создаются под то, что прислали.
  await expect(page.locator('#district-types-hint')).toHaveText('Объектов районов: 4. На карте типов: 2 из 6.');
  await expect(page.locator('[data-district-type="queue"]')).toBeEnabled();
  await expect(page.locator('[data-type-count="queue"]')).toHaveText('1');
  await expect(page.locator('[data-type-count="rotor_transfer"]')).toHaveText('1');
  await expect(page.locator('[data-type-count="dkm_route"]')).toHaveText('0');
  await expect(page.locator('[data-type-count="other"]')).toHaveText('2');

  const withRoutes = await shownLayers(page);
  await page.locator('[data-district-type="rotor_transfer"]').uncheck();
  await expect(page.locator('#district-types-hint')).toHaveText('Объектов районов: 4. На карте типов: 1 из 6.');
  await expect(page.locator('#layer-shown')).toHaveText(String(withRoutes - 1));

  await page.locator('[data-district-type="rotor_transfer"]').check();
  await expect(page.locator('#layer-shown')).toHaveText(String(withRoutes));
  await expect(page.locator('#district-types-hint')).toHaveText('Объектов районов: 4. На карте типов: 2 из 6.');

  // Зоны и точки идут отдельным слоем и по умолчанию скрыты.
  await page.locator('[data-district-type="other"]').check();
  await expect(page.locator('#layer-shown')).toHaveText(String(withRoutes + 1));
  await expect(page.locator('#district-types-hint')).toHaveText('Объектов районов: 4. На карте типов: 3 из 6.');
});

test('дворы грузятся по галочке, а не вместе с картой', async ({ page }) => {
  let yardsRequests = 0;
  await page.route('**/areas.geojson', (route) => {
    yardsRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(YARDS)
    });
  });
  await page.goto(baseURL);
  await waitForLayers(page);
  const withoutYards = await shownLayers(page);
  expect(yardsRequests).toBe(0);

  await page.locator('[data-key="yards"]').check();
  await expect(page.locator('#layer-shown')).toHaveText(String(withoutYards + 1));
  expect(yardsRequests).toBe(1);

  await page.locator('[data-key="yards"]').uncheck();
  await expect(page.locator('#layer-shown')).toHaveText(String(withoutYards));

  // Повторное включение файл не перезапрашивает: слой уже в памяти.
  await page.locator('[data-key="yards"]').check();
  await expect(page.locator('#layer-shown')).toHaveText(String(withoutYards + 1));
  expect(yardsRequests).toBe(1);
});

test('галочка группы убирает и возвращает слои ОДХ одним движением', async ({ page }) => {
  await page.goto(baseURL);
  await waitForLayers(page);
  const withOdh = await shownLayers(page);
  expect(withOdh).toBeGreaterThan(0);

  await page.locator('[data-group="odh"]').uncheck();
  await expect(page.locator('[data-key="queue1"]')).not.toBeChecked();
  // Остаётся только контур САО: у него нет своей галочки, его группа не выключает.
  await expect(page.locator('#layer-shown')).toHaveText('1');

  await page.locator('[data-group="odh"]').check();
  await expect(page.locator('[data-key="queue1"]')).toBeChecked();
  // Обратно включаются все слои группы, включая те, что были скрыты по умолчанию.
  expect(await shownLayers(page)).toBeGreaterThan(withOdh);
});
