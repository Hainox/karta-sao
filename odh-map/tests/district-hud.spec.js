import { expect, test } from '@playwright/test';

const baseURL = 'http://127.0.0.1:8766/odh-map/';

test('редактор показывает полный набор средств для маршрута и роторной зоны', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseURL}district-editor.html`);
  await expect(page.getByRole('heading', { name: 'Карточка набора' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Развернуть направление' }).click();
  await expect(page.getByText('Сопло: справа. Без комментария')).toBeVisible();
});

test('приёмка показывает API-поток и локальный резервный режим', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseURL}district-review.html`);
  await expect(page.getByRole('button', { name: /Загрузить ожидающие/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Выгрузить утверждённые/ })).toBeVisible();
  await expect(page.getByText('Локальная проверка файла')).toBeVisible();
  await expect(page.getByText('Граница САО загружена. Подключите API или выберите GeoJSON-файлы.')).toBeVisible();
  expect(errors).toEqual([]);
});
