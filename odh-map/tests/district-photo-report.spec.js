import { test, expect } from '@playwright/test';

// Кабинет приёмки районных карт выгружает свод по фото въездных групп в Excel.
test('кабинет въездных групп скачивает свод по фото одной кнопкой', async ({ page }) => {
  let reportRequests = 0;
  await page.clock.setFixedTime(new Date('2026-10-28T09:00:00Z'));
  await page.addInitScript(() => sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' })));
  await page.route('**/api/object-photo-points/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/district-photos/queue')) {
      return route.fulfill({ json: { counts: { total: 1, empty: 1, pending: 0, accepted: 0, rework: 0 }, pending: [], rework: [] } });
    }
    if (pathname.endsWith('/district-photos/report.xlsx')) {
      reportRequests += 1;
      return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from([0x50, 0x4b, 0x03, 0x04]) });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('http://127.0.0.1:8766/districts/review.html');
  const button = page.getByRole('button', { name: 'Excel: свод по фото' });
  await expect(button).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await button.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Svod_foto_vezdnye_gruppy_SAO_2026-10-28.xlsx');
  expect(reportRequests).toBe(1);
  await expect(page.locator('#listStatus')).toHaveText('Свод скачан.');
});
