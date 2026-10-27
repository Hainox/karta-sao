import { expect, test } from '@playwright/test';

test('кабинет приёмки фильтрует очередь и требует причину возврата', async ({ page }) => {
  let reviewBody;
  const firstId = '00000000-0000-4000-8000-000000000001';
  const secondId = '00000000-0000-4000-8000-000000000002';
  let firstStatus = 'pending_review';
  let secondStatus = 'pending_review';
  let reviewSessionHeader;
  await page.route('https://mock.test/photo-api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/login')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'test-token', user: { displayName: 'Префектура', role: 'prefecture_admin' } }) });
    if (url.pathname.endsWith('/review/claim')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ objectKey: JSON.parse(route.request().postData() || '{}').objectKey, leaseSeconds: 1800 }) });
    if (url.pathname.endsWith('/review/history')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 7, objectKey: 'stops|Аэропорт|old', label: 'Остановка В истории', district: 'Аэропорт', objectType: 'stop', status: 'confirmed', operator: 'Префектура', createdAt: '2026-09-21T10:00:00Z' }] }) });
    if (url.pathname.endsWith('/review/queue')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ objects: [
      { objectKey: 'stops|Аэропорт|1', objectType: 'stop', district: 'Аэропорт', label: 'Остановка Тестовая', sourcePointCount: 1, photos: [{ id: firstId, reviewStatus: firstStatus, isReference: false, comment: 'Снято после уборки территории', reviewReason: firstStatus === 'rejected' ? 'Не видно маркировку' : null }] },
      { objectKey: 'stops|Аэропорт|2', objectType: 'stop', district: 'Аэропорт', label: 'Остановка Следующая', sourcePointCount: 1, photos: [{ id: secondId, reviewStatus: secondStatus, isReference: false, reviewReason: secondStatus === 'rejected' ? 'Не видно маркировку' : null }] }
    ] }) });
    if (url.pathname.endsWith('/content')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    if (url.pathname.endsWith('/review')) { reviewSessionHeader = route.request().headers()['x-review-session']; reviewBody = JSON.parse(route.request().postData() || '{}'); if (url.pathname.includes(firstId)) firstStatus = reviewBody.status; if (url.pathname.includes(secondId)) secondStatus = reviewBody.status; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto('http://127.0.0.1:8766/review-cabinet/?api=https%3A%2F%2Fmock.test%2Fphoto-api');
  await page.getByLabel('Логин').fill('prefecture@example.test');
  await page.getByLabel('Пароль').fill('secret');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByLabel('Район')).toContainText('Аэропорт');
  await page.getByRole('button', { name: /История проверок/ }).click();
  await expect(page.getByText('Остановка В истории')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByRole('button', { name: /Остановка Тестовая/ })).toBeVisible();
  await page.getByRole('button', { name: /Остановка Тестовая/ }).click();
  await expect(page.getByText('Принятое фото автоматически станет эталонным.')).toBeVisible();
  await expect(page.getByText('Комментарий района')).toBeVisible();
  await expect(page.getByText('Снято после уборки территории')).toBeVisible();
  await page.keyboard.press('t');
  await expect.poll(() => reviewBody).toMatchObject({ status: 'confirmed', reason: '' });
  expect(reviewSessionHeader).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Остановка Следующая' })).toBeVisible();
  await page.keyboard.press('u');
  await expect(page.getByText('Укажите причину возврата на доработку.')).toBeVisible();
  await page.getByLabel('Комментарий к возврату').fill('Не видно маркировку');
  await page.getByRole('heading', { name: 'Остановка Следующая' }).click();
  await page.keyboard.press('u');
  await expect.poll(() => reviewBody).toMatchObject({ status: 'rejected', reason: 'Не видно маркировку' });
  await expect(page.getByText('Поток заданий на проверку завершён.')).toBeVisible();
});

test('кабинет приёмки выгружает Excel-сводку по текущему фильтру вида работ', async ({ page }) => {
  let exportUrl;
  await page.route('https://mock.test/photo-api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/login')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'test-token', user: { displayName: 'Префектура', role: 'prefecture_admin' } }) });
    if (url.pathname.endsWith('/review/history')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    if (url.pathname.endsWith('/review/queue')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ objects: [
      { objectKey: 'entrances|Аэропорт|1', objectType: 'entrance', district: 'Аэропорт', label: 'Подъезд Тестовый', sourcePointCount: 1, photos: [{ id: '00000000-0000-4000-8000-000000000003', reviewStatus: 'pending_review', isReference: false }] },
    ] }) });
    if (url.pathname.endsWith('/reports/review.xlsx')) {
      exportUrl = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers: { 'Content-Disposition': 'attachment; filename="Svod_foto_podezdy_SAO_2026-10-27.xlsx"' },
        body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      });
    }
    if (url.pathname.endsWith('/content')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto('http://127.0.0.1:8766/review-cabinet/?api=https%3A%2F%2Fmock.test%2Fphoto-api');
  await page.getByLabel('Логин').fill('prefecture@example.test');
  await page.getByLabel('Пароль').fill('secret');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('button', { name: 'Excel: свод по фото' })).toBeVisible();
  await page.getByLabel('Вид работ').selectOption('entrance');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel: свод по фото' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Svod_foto_podezdy_SAO_2026-10-27.xlsx');
  expect(exportUrl).toContain('type=entrance');
  await expect(page.locator('#saveState')).toContainText('Свод скачан');
});
