import { expect, test } from '@playwright/test';

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
  await page.locator('#drawButton').click();
  await expect(page.getByText('Очередь 1 · Тестовый проезд', { exact: true })).toBeVisible();
  await expect(page.locator('.route-travel-arrow')).toHaveCount(2);
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
  await page.goto(`${baseURL}district-review.html`);
  await expect(page.getByRole('link', { name: /Памятка префектуры/ })).toHaveAttribute('href', 'prefecture-guide.html');

  await page.goto(`${baseURL}prefecture-guide.html`);
  await expect(page.getByRole('heading', { name: 'Памятка префектуры: как принимать карты и помогать районам' })).toBeVisible();
  await expect(page.getByText('Загрузить ожидающие', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Публичная карта сама от этого не меняется', { exact: false })).toBeVisible();
});
