import { test, expect } from '@playwright/test';

// Архив фото: ссылка на файл должна быть абсолютной и вести в фотослужбу,
// а не на GitHub Pages. Раньше при пустом api.base браузер уходил на сайт
// атласа вместо скачивания ZIP.
test('архив фото скачивается по абсолютной ссылке и не уводит со страницы', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' })));
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
