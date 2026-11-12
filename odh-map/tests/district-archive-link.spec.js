import { test, expect } from '@playwright/test';

// Архив фото: ссылка на файл должна быть абсолютной и вести в фотослужбу,
// а не на GitHub Pages. Раньше при пустом api.base браузер уходил на сайт
// атласа вместо скачивания ZIP.
test('архив фото скачивается по абсолютной ссылке и не уводит со страницы', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' }));
    // Проверяем запасной путь со ссылкой, как в браузере без File System Access.
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.route('**/api/object-photo-points/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/district-photos/queue')) {
      return route.fulfill({ json: { counts: { total: 0, empty: 0, pending: 0, accepted: 0, rework: 0 }, pending: [], rework: [] } });
    }
    if (pathname.endsWith('/district-photos/photos.zip/prepare')) {
      return route.fulfill({ status: 202, json: { id: 'job-1', status: 'building', total: 2 } });
    }
    if (pathname.endsWith('/district-photos/photos.zip/prepare/job-1')) {
      return route.fulfill({ json: { id: 'job-1', status: 'ready', photos: 2, total: 2, bytes: 2048, name: 'sao-photos-test.zip', ticket: 'ticket-1' } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('**/reports/photos.zip/file/**', async (route) => {
    return route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="sao-photos-test.zip"' },
      body: Buffer.from('PK\x03\x04'),
    });
  });
  await page.goto('http://127.0.0.1:8766/districts/review.html');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Архив фото (ZIP)' }).click();
  const download = await downloadPromise;
  expect(new URL(download.url()).origin).toBe('http://127.0.0.1:8789');
  expect(new URL(download.url()).pathname).toBe('/api/reports/photos.zip/file/sao-photos-test.zip');
  expect(download.suggestedFilename()).toBe('sao-photos-test.zip');
  expect(new URL(page.url()).pathname).toBe('/districts/review.html');
});

test('большой архив сохраняется потоком, не уходя навигацией на obhod-sao.ru', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' }));
    window.__archiveBytes = 0;
    window.showSaveFilePicker = async () => ({
      name: 'sao-photos-test.zip',
      createWritable: async () => new WritableStream({
        write(chunk) { window.__archiveBytes += chunk.length; },
      }),
    });
  });
  await page.route('**/api/object-photo-points/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/district-photos/queue')) {
      return route.fulfill({ json: { counts: { total: 0, empty: 0, pending: 0, accepted: 0, rework: 0 }, pending: [], rework: [] } });
    }
    if (pathname.endsWith('/district-photos/photos.zip/prepare')) {
      return route.fulfill({ status: 202, json: { id: 'job-1', status: 'building', total: 2 } });
    }
    if (pathname.endsWith('/district-photos/photos.zip/prepare/job-1')) {
      return route.fulfill({ json: { id: 'job-1', status: 'ready', photos: 2, total: 2, bytes: 2048, name: 'sao-photos-test.zip', ticket: 'ticket-1' } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('**/reports/photos.zip/file/**', async (route) => {
    return route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="sao-photos-test.zip"',
        'Access-Control-Allow-Origin': '*',
      },
      body: Buffer.from('PK\x03\x04'),
    });
  });
  await page.goto('http://127.0.0.1:8766/districts/review.html');
  await page.getByRole('button', { name: 'Архив фото (ZIP)' }).click();
  await expect.poll(() => page.evaluate(() => window.__archiveBytes)).toBeGreaterThan(0);
  expect(new URL(page.url()).pathname).toBe('/districts/review.html');
  await expect(page.locator('#listStatus')).toContainText('Архив сохранён');
});

test('смена вкладки сбрасывает прогресс старого архива', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' }));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.route('**/api/object-photo-points/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/queue')) {
      return route.fulfill({ json: { counts: { total: 0, empty: 0, pending: 0, accepted: 0, rework: 0 }, pending: [], rework: [] } });
    }
    if (pathname.endsWith('/photos.zip/prepare') || pathname.endsWith('/photos.zip/prepare/job-slow')) {
      return route.fulfill({ status: 202, json: { id: 'job-slow', status: 'building', photos: 0, total: 4666 } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('http://127.0.0.1:8766/districts/review.html');
  const archive = page.getByRole('button', { name: 'Архив фото (ZIP)' });
  await archive.click();
  await page.getByRole('tab', { name: 'Тротуары Дворы' }).click();
  await page.waitForTimeout(3500);
  await expect(page.getByRole('button', { name: 'Архив фото (ZIP)' })).toBeEnabled();
  await expect(page.locator('#listStatus')).not.toContainText('Собираем архив');
});
