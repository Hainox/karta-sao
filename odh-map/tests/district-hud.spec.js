import { expect, test } from './fixtures.js';
import { readFile } from 'node:fs/promises';

const baseURL = 'http://127.0.0.1:8766/odh-map/';

test('редактор показывает полный набор средств для маршрута и роторной зоны', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseURL}district-editor.html`);
  await expect(page.getByRole('heading', { name: 'Карточка набора' })).toBeVisible();
  await expect(page.locator('.leaflet-control-attribution')).not.toContainText('Leaflet');
  await expect(page.getByRole('button', { name: /Установить начало/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Установить конец/ })).toBeVisible();
  await expect(page.getByLabel('Направление сопла')).toBeVisible();
  await page.locator('#district').selectOption('Войковский');
  await expect(page.locator('.district-highlight')).not.toHaveCount(0);
  await page.locator('#changeType').selectOption('rotor_snow_storage_zone');
  await expect(page.getByRole('button', { name: /Нарисовать зону/ })).toBeVisible();
  await expect(page.locator('#routeWrap')).toBeHidden();
  expect(errors).toEqual([]);
});

test('районная ссылка подставляет логин и не даёт менять адрес базы', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html?district=%D0%90%D1%8D%D1%80%D0%BE%D0%BF%D0%BE%D1%80%D1%82`);
  await expect(page.locator('#apiEmail')).toHaveValue('Аэропорт');
  await expect(page.locator('#apiBase')).toHaveAttribute('readonly', '');
});

test('маршрут сохраняется по явной кнопке завершения', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  await page.locator('#district').selectOption('Аэропорт');
  await page.locator('#author').fill('Иванов И.И.');
  await page.locator('#address').fill('Тестовый проезд');
  const map = page.locator('#map');
  await page.locator('#setStart').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#setEnd').click();
  await map.click({ position: { x: 450, y: 390 } });
  await page.locator('#drawButton').click();
  await expect(page.getByRole('button', { name: /Завершить маршрут/ })).toBeVisible();
  const previewLine = page.locator('#map .leaflet-overlay-pane path[stroke="#ff4e64"]');
  await expect(previewLine).toHaveCount(1);
  expect(await previewLine.getAttribute('stroke-dasharray')).toBeNull();
  await page.locator('#drawButton').click();
  await expect(page.getByText('Очередь 1 · Тестовый проезд', { exact: true })).toBeVisible();
  await expect(page.locator('.route-travel-arrow')).toHaveCount(2);
  await expect(page.locator('#status')).toContainText('Добавлено: Очередь 1');
  const draftLine = page.locator('#map .leaflet-overlay-pane path[stroke="#ff4e64"]');
  await expect(draftLine).toHaveCount(1);
  expect(await draftLine.getAttribute('stroke-dasharray')).toBeNull();
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('odh-map-district-change-draft-v2')));
  expect(draft.features).toHaveLength(1);
  expect(draft.features[0].geometry.coordinates).toHaveLength(2);
  await page.reload();
  await expect(page.getByText('Очередь 1 · Тестовый проезд', { exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click()
  ]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.features).toHaveLength(1);
  expect(exported.features[0].geometry.type).toBe('LineString');

  await page.goto(`${baseURL}district-review.html`);
  await page.locator('#reviewFiles').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/geo+json',
    buffer: Buffer.from(JSON.stringify(exported))
  });
  await expect(page.locator('.route-endpoint.start')).toHaveCount(1);
  await expect(page.locator('.route-endpoint.end')).toHaveCount(1);
  await expect(page.locator('.route-travel-arrow')).toHaveCount(2);
});

test('маршрут завершается и отображается, даже если браузер запрещает локальное сохранение', async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'odh-map-district-change-draft-v2') throw new DOMException('Storage is unavailable', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    };
  });
  await page.goto(`${baseURL}district-editor.html`);
  await page.locator('#district').selectOption('Аэропорт');
  await page.locator('#author').fill('Тестовый исполнитель');
  await page.locator('#address').fill('Синтетический тестовый проезд');
  const map = page.locator('#map');
  await page.locator('#setStart').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#setEnd').click();
  await map.click({ position: { x: 450, y: 390 } });
  await page.locator('#drawButton').click();
  await expect(page.getByRole('button', { name: /Завершить маршрут/ })).toBeVisible();
  await page.locator('#drawButton').click();
  await expect(page.getByText('Очередь 1 · Синтетический тестовый проезд', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Нарисовать маршрут/ })).toBeVisible();
  await expect(page.locator('#status')).toContainText('локальное сохранение не сработало');
  await page.locator('#saveButton').click();
  await expect(page.locator('#status')).toContainText('Браузер не сохранил черновик');
});

test('редактор открывается с пустым черновиком, если чтение localStorage запрещено', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'odh-map-district-change-draft-v2' || key === 'odh-map-district-change-draft-v1') throw new DOMException('Storage is unavailable', 'SecurityError');
      return originalGetItem.call(this, key);
    };
  });
  await page.goto(`${baseURL}district-editor.html`);
  await expect(page.getByRole('heading', { name: 'Карточка набора' })).toBeVisible();
  await expect(page.locator('#featureList')).toContainText('Пока ничего не добавлено.');
  await expect(page.locator('#drawButton')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('повреждённый черновик не мешает запуску, если localStorage не даёт его удалить', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const key = 'odh-map-district-change-draft-v2';
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    originalSetItem.call(localStorage, key, '{invalid json');
    Storage.prototype.removeItem = function (itemKey) {
      if (itemKey === key) throw new DOMException('Storage is unavailable', 'SecurityError');
      return originalRemoveItem.call(this, itemKey);
    };
  });
  await page.goto(`${baseURL}district-editor.html`);
  await expect(page.getByRole('heading', { name: 'Карточка набора' })).toBeVisible();
  await expect(page.locator('#featureList')).toContainText('Пока ничего не добавлено.');
  await expect(page.locator('#drawButton')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('точечный объект остаётся в черновике и сообщает об отказе localStorage', async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'odh-map-district-change-draft-v2') throw new DOMException('Storage is unavailable', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    };
  });
  await page.goto(`${baseURL}district-editor.html`);
  await page.locator('#district').selectOption('Аэропорт');
  await page.locator('#author').fill('Тестовый исполнитель');
  await page.locator('#address').fill('Синтетическая точка для теста');
  await page.locator('#changeType').selectOption('temporary_snow_storage');
  await page.locator('#drawButton').click();
  await page.locator('#map').click({ position: { x: 420, y: 360 } });
  await expect(page.getByText('Временное складирование снега · Синтетическая точка для теста', { exact: true })).toBeVisible();
  await expect(page.locator('#status')).toContainText('Браузер не сохранил черновик');
  await expect(page.locator('#drawButton')).toBeEnabled();
});

test('совпавшие начало и конец не сбрасывают рисование до добавления поворота', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  await page.locator('#district').selectOption('Аэропорт');
  await page.locator('#author').fill('Тестовый исполнитель');
  await page.locator('#address').fill('Синтетический замкнутый маршрут');
  const map = page.locator('#map');
  await page.locator('#setStart').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#setEnd').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#drawButton').click();
  await page.locator('#drawButton').click();
  await expect(page.locator('#status')).toContainText('Начало и конец совпадают');
  await expect(page.getByRole('button', { name: /Завершить маршрут/ })).toBeVisible();

  await map.click({ position: { x: 435, y: 375 } });
  await page.locator('#drawButton').click();
  await expect(page.getByText('Очередь 1 · Синтетический замкнутый маршрут', { exact: true })).toBeVisible();
});

test('редактор импортирует маршрут v2 и разворачивает его направление', async ({ page }) => {
  const route = {
    type: 'FeatureCollection', change_set_version: 'district_change_set_v2', district: 'Аэропорт', author: 'Иванов И.И.', features: [{
      type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.53, 55.82], [37.54, 55.83]] },
      properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'queue', queue_priority: '1', address: 'Тестовый маршрут', route_start: [37.53, 55.82], route_end: [37.54, 55.83], route_direction: 'start_to_end', nozzle_direction: 'left' }
    }]
  };
  await page.goto(`${baseURL}district-editor.html`);
  await expect(page.locator('#importInput')).toBeEnabled();
  await page.locator('#importInput').setInputFiles({ name: 'route.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(route)) });
  await expect(page.getByText('Очередь 1 · Тестовый маршрут')).toBeVisible();
  await expect(page.getByText('Сопло: слева. Без комментария')).toBeVisible();
  await expect(page.getByRole('button', { name: /Проверить перед отправкой/ })).toBeVisible();
  await expect(page.locator('.route-endpoint.start')).toHaveCount(1);
  await expect(page.locator('.route-endpoint.end')).toHaveCount(1);
  await expect(page.locator('.route-travel-arrow')).toHaveCount(2);
  await expect(page.locator('.route-nozzle-arrow.left')).toHaveCount(1);
  await page.getByRole('button', { name: 'Развернуть направление' }).click();
  await expect(page.getByText('Сопло: справа. Без комментария')).toBeVisible();
});

test('возвращённый набор открывается в черновике для исправления', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('odh-map-api-token-v1', 'test-token');
    sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ id: 'editor-1', email: 'аэропорт', role: 'district_editor', district: 'Аэропорт' }));
  });
  const returned = {
    type: 'FeatureCollection', change_set_version: 'district_change_set_v2', district: 'Аэропорт', author: 'Иванов И.И.',
    features: [{
      type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.53, 55.82], [37.54, 55.83]] },
      properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'queue', queue_priority: '1', address: 'Возвращённый маршрут', route_start: [37.53, 55.82], route_end: [37.54, 55.83], route_direction: 'start_to_end', nozzle_direction: 'left' }
    }]
  };
  await page.route('**/api/my-submissions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    // Отклонённый набор приходит с объектами, набор на приёмке — без них: править
    // можно только возвращённый.
    body: JSON.stringify({ district: 'Аэропорт', submissions: [
      { id: 'returned-1', district: 'Аэропорт', status: 'rejected', submitted_at: '2026-09-16T10:00:00.000Z', review_comment: 'Уточните направление сопла', features: 1, change_set: returned },
      { id: 'waiting-1', district: 'Аэропорт', status: 'submitted', submitted_at: '2026-09-17T10:00:00.000Z', review_comment: null, features: 1 }
    ] })
  }));
  await page.goto(`${baseURL}district-editor.html`);
  await page.locator('#mySubmissionsButton').click();
  await expect(page.getByText('Комментарий приёмки: Уточните направление сопла')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Продолжить редактирование' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Продолжить редактирование' }).click();
  await expect(page.getByText('Возвращённый набор открыт в черновике. Объектов: 1. Исправьте и отправьте снова.')).toBeVisible();
  await expect(page.getByText('Очередь 1 · Возвращённый маршрут')).toBeVisible();

  // Возвращённый набор лёг в черновик: правки не потеряются при перезагрузке.
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('odh-map-district-change-draft-v2')));
  expect(draft.features).toHaveLength(1);
  expect(draft.features[0].properties.address).toBe('Возвращённый маршрут');
});

test('приёмка показывает API-поток и локальный резервный режим', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseURL}district-review.html`);
  await expect(page.locator('.leaflet-control-attribution')).not.toContainText('Leaflet');
  await expect(page.getByRole('button', { name: /Загрузить ожидающие/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Выгрузить утверждённые/ })).toBeVisible();
  await expect(page.getByText('Порядок приёмки')).toBeVisible();
  await expect(page.getByText('Тёмно-синие стрелки показывают ход техники.')).toBeVisible();
  await expect(page.getByText('Локальная проверка файла')).toBeVisible();
  await expect(page.getByText('Граница САО загружена. Подключите API или выберите GeoJSON-файлы.')).toBeVisible();
  const route = { type: 'FeatureCollection', change_set_version: 'district_change_set_v2', district: 'Аэропорт', author: 'Иванов И.И.', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.53, 55.82], [37.54, 55.83]] }, properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'rotor_transfer', address: 'Тестовая перекидка', route_start: [37.53, 55.82], route_end: [37.54, 55.83], route_direction: 'start_to_end', nozzle_direction: 'both' } }] };
  await page.locator('#reviewFiles').setInputFiles({ name: 'rotor.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(route)) });
  await expect(page.locator('.route-endpoint.start')).toHaveCount(1);
  await expect(page.locator('.route-endpoint.end')).toHaveCount(1);
  await expect(page.locator('.route-travel-arrow')).toHaveCount(2);
  await expect(page.locator('.route-nozzle-arrow')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('отправленный набор очищает черновик, чтобы не ушёл повторно', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('odh-map-api-token-v1', 'test-token');
    sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ id: 'editor-1', email: 'аэропорт', role: 'district_editor', district: 'Аэропорт' }));
  });
  const submissions = [];
  await page.route('**/api/submissions', async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ submission: { id: 'test-submission', district: 'Аэропорт', status: 'submitted' } }) });
  });
  await page.goto(`${baseURL}district-editor.html`);
  await expect(page.locator('#district')).toHaveValue('Аэропорт');
  await page.locator('#author').fill('Иванов И.И.');
  await page.locator('#address').fill('Тестовый проезд');
  const map = page.locator('#map');
  await page.locator('#setStart').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#setEnd').click();
  await map.click({ position: { x: 450, y: 390 } });
  await page.locator('#drawButton').click();
  await page.locator('#drawButton').click();
  await page.locator('#submitButton').click();
  await expect(page.locator('#status')).toContainText('Набор отправлен на приёмку');
  expect(submissions).toHaveLength(1);
  await expect(page.locator('#featureList')).toContainText('Пока ничего не добавлено');
  expect(await page.evaluate(() => localStorage.getItem('odh-map-district-change-draft-v2'))).toBeNull();
});

test('отказ сервера показывает причины, а черновик остаётся на месте', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('odh-map-api-token-v1', 'test-token');
    sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ id: 'editor-1', email: 'аэропорт', role: 'district_editor', district: 'Аэропорт' }));
  });
  await page.route('**/api/submissions', async (route) => {
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Набор не прошёл проверку.',
        details: ['Объект 7 (Маршрут ДКМ — ОДХ · Дмитровское шоссе, у д. 90): начало и конец маршрута должны быть явно заданы.']
      })
    });
  });
  await page.goto(`${baseURL}district-editor.html`);
  await expect(page.locator('#district')).toHaveValue('Аэропорт');
  await page.locator('#author').fill('Иванов И.И.');
  await page.locator('#address').fill('Тестовый проезд');
  const map = page.locator('#map');
  await page.locator('#setStart').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#setEnd').click();
  await map.click({ position: { x: 450, y: 390 } });
  await page.locator('#drawButton').click();
  await page.locator('#drawButton').click();
  await page.locator('#submitButton').click();

  const status = page.locator('#status');
  await expect(status).toContainText('Набор не прошёл проверку');
  await expect(status).toContainText('Объект 7 (Маршрут ДКМ — ОДХ');
  await expect(page.locator('#featureList')).toContainText('Тестовый проезд');
});

test('фото-метки появляются только в контуре префектуры', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('odh-map-api-token-v1', 'test-token');
    sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ id: 'prefecture-1', email: 'prefecture@example.test', role: 'prefecture_admin', district: null }));
  });
  await page.route('**/api/photo-markers', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ photoMarkers: [] }) });
  });
  await page.goto(`${baseURL}district-review.html`);
  await expect(page.getByRole('heading', { name: 'Фото-метки префектуры' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Расставить фото-метки/ })).toBeVisible();
  await expect(page.getByText('Создавать, менять и удалять фото-метки может только учётная запись префектуры.')).toBeVisible();
});

test('каталог ведёт район к правильному рабочему контуру', async ({ page }) => {
  await page.goto('http://127.0.0.1:8766/hub/');
  await expect(page.getByRole('heading', { name: 'Нужно расчерчивать — начните здесь' })).toBeVisible();
  const start = page.getByRole('link', { name: /Открыть ссылку своего района/ });
  await expect(start).toHaveAttribute('href', '../odh-map/district-links.html');
  await expect(page.getByText('Только после зелёной проверки нажимайте «Отправить на приёмку».')).toBeVisible();
});

test('памятка префектуры объясняет приёмку и доступна из рабочего контура', async ({ page }) => {
  await page.goto(`${baseURL}district-review.html`, { waitUntil:'domcontentloaded' });
  await expect(page.getByRole('link', { name: /Памятка префектуры/ })).toHaveAttribute('href', 'prefecture-guide.html');

  await page.goto(`${baseURL}prefecture-guide.html`, { waitUntil:'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Памятка префектуры: как принимать карты и помогать районам' })).toBeVisible();
  await expect(page.getByText('Загрузить ожидающие', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Публичная карта сама от этого не меняется', { exact: false })).toBeVisible();
});

test('район видит подпись объекта с номером, режим подписей и легенду типов', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  await page.locator('#district').selectOption('Аэропорт');
  await page.locator('#author').fill('Иванов И.И.');
  await page.locator('#address').fill('Тестовый проезд');
  const map = page.locator('#map');
  await page.locator('#setStart').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#setEnd').click();
  await map.click({ position: { x: 450, y: 390 } });
  await page.locator('#drawButton').click();
  await page.locator('#drawButton').click();

  // Номер объекта и его подпись: по ним объект называют и район, и префектура.
  await expect(page.locator('#featureList .object-badge')).toHaveText('ОЧ-I №1');
  const label = page.locator('#map .object-label');
  await expect(label).toHaveCount(1);
  await expect(label).toContainText('ОЧ-I №1');
  await expect(label).toContainText('Тестовый проезд');

  const toggle = page.locator('#labelsToggle button.labels-toggle');
  await expect(toggle).toHaveText('Подписи: все');
  await toggle.click();
  await expect(toggle).toHaveText('Подписи: по наведению');
  await expect(toggle).toHaveAttribute('data-mode', 'hover');
  await expect(label).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-mode', 'all');
  await expect(label).toHaveCount(1);

  const legend = page.locator('#typeLegend');
  await expect(legend).toContainText('Очередность уборки');
  await expect(legend).toContainText('Роторная перекидка');
  await expect(legend).toContainText('Проезд дорожной коммунальной машины по дорогам');

  await page.getByRole('button', { name: 'Показать на карте' }).click();
  const popup = page.locator('.leaflet-popup-content');
  await expect(popup).toContainText('Очередность уборки');
  await expect(popup).toContainText('Балансодержатель');
  await expect(popup).toContainText('Жилищник «Аэропорт»');

  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('odh-map-district-change-draft-v2')));
  expect(draft.features[0].properties.object_no).toBe(1);
});

test('приёмка видит номера объектов и по клику подводит карту к объекту', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  await page.locator('#district').selectOption('Аэропорт');
  await page.locator('#author').fill('Иванов И.И.');
  await page.locator('#address').fill('Тестовый проезд');
  const map = page.locator('#map');
  await page.locator('#setStart').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#setEnd').click();
  await map.click({ position: { x: 450, y: 390 } });
  await page.locator('#drawButton').click();
  await page.locator('#drawButton').click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click()
  ]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));

  await page.goto(`${baseURL}district-review.html`);
  await page.locator('#reviewFiles').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/geo+json',
    buffer: Buffer.from(JSON.stringify(exported))
  });

  // Журнал объектов закрывает главный разрыв: раньше префектура видела только линии.
  await expect(page.locator('#objectJournal .object-row')).toHaveCount(1);
  await expect(page.locator('#objectJournal .object-row .object-badge')).toHaveText('ОЧ-I №1');
  await expect(page.locator('#objectJournal')).toContainText('Очередность уборки');
  await expect(page.locator('#objectJournalCount')).toHaveText('Показано 1 из 1');
  await expect(page.locator('#fileList')).toContainText('Балансодержатель: Жилищник «Аэропорт»');
  await expect(page.locator('#map .object-label')).toContainText('ОЧ-I №1');

  await page.locator('#objectJournal .object-row').click();
  const popup = page.locator('.leaflet-popup-content');
  await expect(popup).toContainText('Очередность уборки');
  await expect(popup).toContainText('Исполнитель');
  await expect(popup).toContainText('Иванов И.И.');
});
