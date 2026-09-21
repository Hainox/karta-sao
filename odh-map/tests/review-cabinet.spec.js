import { expect, test } from '@playwright/test';

test('кабинет приёмки фильтрует очередь и требует причину возврата', async ({ page }) => {
  let reviewBody;
  const firstId = '00000000-0000-4000-8000-000000000001';
  const secondId = '00000000-0000-4000-8000-000000000002';
  let firstStatus = 'pending_review';
  let secondStatus = 'pending_review';
  await page.route('https://mock.test/photo-api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/login')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'test-token', user: { displayName: 'Префектура', role: 'prefecture_admin' } }) });
    if (url.pathname.endsWith('/review/claim')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ objectKey: JSON.parse(route.request().postData() || '{}').objectKey, leaseSeconds: 1800 }) });
    if (url.pathname.endsWith('/review/queue')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ objects: [
      { objectKey: 'stops|Аэропорт|1', objectType: 'stop', district: 'Аэропорт', label: 'Остановка Тестовая', sourcePointCount: 1, photos: [{ id: firstId, reviewStatus: firstStatus, isReference: false, reviewReason: firstStatus === 'rejected' ? 'Не видно маркировку' : null }] },
      { objectKey: 'stops|Аэропорт|2', objectType: 'stop', district: 'Аэропорт', label: 'Остановка Следующая', sourcePointCount: 1, photos: [{ id: secondId, reviewStatus: secondStatus, isReference: false, reviewReason: secondStatus === 'rejected' ? 'Не видно маркировку' : null }] }
    ] }) });
    if (url.pathname.endsWith('/content')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    if (url.pathname.endsWith('/review')) { reviewBody = JSON.parse(route.request().postData() || '{}'); if (url.pathname.includes(firstId)) firstStatus = reviewBody.status; if (url.pathname.includes(secondId)) secondStatus = reviewBody.status; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto('http://127.0.0.1:8766/review-cabinet/?api=https%3A%2F%2Fmock.test%2Fphoto-api');
  await page.getByLabel('Логин').fill('prefecture@example.test');
  await page.getByLabel('Пароль').fill('secret');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByLabel('Район')).toContainText('Аэропорт');
  await expect(page.getByRole('button', { name: /Остановка Тестовая/ })).toBeVisible();
  await page.getByRole('button', { name: /Остановка Тестовая/ }).click();
  await expect(page.getByText('Принятое фото автоматически станет эталонным.')).toBeVisible();
  await page.keyboard.press('t');
  await expect.poll(() => reviewBody).toMatchObject({ status: 'confirmed', reason: '' });
  await expect(page.getByRole('heading', { name: 'Остановка Следующая' })).toBeVisible();
  await page.keyboard.press('u');
  await expect(page.getByText('Укажите причину возврата на доработку.')).toBeVisible();
  await page.getByLabel('Комментарий к возврату').fill('Не видно маркировку');
  await page.getByRole('heading', { name: 'Остановка Следующая' }).click();
  await page.keyboard.press('u');
  await expect.poll(() => reviewBody).toMatchObject({ status: 'rejected', reason: 'Не видно маркировку' });
  await expect(page.getByText('Поток заданий на проверку завершён.')).toBeVisible();
});
