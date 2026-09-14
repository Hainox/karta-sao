import { expect, test } from '@playwright/test';

const baseURL = 'http://127.0.0.1:8766/odh-map/';

async function drawRoute(page, changeType, address) {
  await page.goto(`${baseURL}district-editor.html`);
  await page.locator('#district').selectOption('Аэропорт');
  await page.locator('#author').fill('Тестовый исполнитель');
  await page.locator('#address').fill(address);
  await page.locator('#changeType').selectOption(changeType);

  const map = page.locator('#map');
  await page.locator('#setStart').click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator('#setEnd').click();
  await map.click({ position: { x: 450, y: 390 } });
  await page.locator('#drawButton').click();
  await expect(page.getByRole('button', { name: /Завершить маршрут/ })).toBeVisible();
}

test('маршрут уборки остаётся сплошным при рисовании и после сохранения', async ({ page }) => {
  await drawRoute(page, 'queue', 'Синтетический тест уборки');

  const preview = page.locator('#map .leaflet-overlay-pane path[stroke="#ff4e64"]');
  await expect(preview).toHaveCount(1);
  expect(await preview.getAttribute('stroke-dasharray')).toBeNull();

  await page.locator('#drawButton').click();
  const savedRoute = page.locator('#map .leaflet-overlay-pane path[stroke="#ff4e64"]');
  await expect(savedRoute).toHaveCount(1);
  expect(await savedRoute.getAttribute('stroke-dasharray')).toBeNull();

  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('odh-map-district-change-draft-v2')));
  expect(draft.features[0].properties.change_type).toBe('queue');
});

test('роторная перекидка остаётся пунктирной при рисовании и после сохранения', async ({ page }) => {
  await drawRoute(page, 'rotor_transfer', 'Синтетический тест перекидки');

  const preview = page.locator('#map .leaflet-overlay-pane path[stroke="#b98cff"]');
  await expect(preview).toHaveCount(1);
  expect(await preview.getAttribute('stroke-dasharray')).toBe('4 9');

  await page.locator('#drawButton').click();
  const savedRoute = page.locator('#map .leaflet-overlay-pane path[stroke="#b98cff"]');
  await expect(savedRoute).toHaveCount(1);
  expect(await savedRoute.getAttribute('stroke-dasharray')).toBe('4 9');

  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('odh-map-district-change-draft-v2')));
  expect(draft.features[0].properties.change_type).toBe('rotor_transfer');
});
