import { test, expect } from '@playwright/test';

// Кабинет приёмки районных карт, режим «ДП и СП»: тот же поток, что у въездных групп,
// плюс фильтр вида площадки и свой свод в Excel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=', 'base64');

async function cabinet(page) {
  const reviews = [];
  const pending = [
    { point_id: 'pg-1', label: 'Коптевская ул., 30', district: 'Коптево', kind: 'dp', photo_id: 'f-1', uploaded_at: '2026-10-28T05:00:00Z', photo_filename: 'dp.jpg' },
    { point_id: 'pg-2', label: 'Коптевская ул., 32', district: 'Коптево', kind: 'sp', photo_id: 'f-2', uploaded_at: '2026-10-28T06:00:00Z', photo_filename: 'sp.jpg' },
  ];
  const rework = [{ point_id: 'pg-3', label: 'Ул. Зои и Александра Космодемьянских, 7', district: 'Войковский', kind: 'dp', photo_id: null, rejected_comment: 'Площадка не в кадре', rejected_at: '2026-10-27T10:00:00Z' }];
  await page.clock.setFixedTime(new Date('2026-10-28T09:00:00Z'));
  await page.addInitScript(() => sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' })));
  await page.route('**/api/object-photo-points/**', async (route) => {
    const request = route.request();
    const pathname = decodeURIComponent(new URL(request.url()).pathname);
    if (pathname.endsWith('/district-photos/queue')) return route.fulfill({ json: { counts: { total: 0, empty: 0, pending: 0, accepted: 0, rework: 0 }, pending: [], rework: [] } });
    if (pathname.endsWith('/playgrounds/queue')) {
      const open = pending.filter((row) => !reviews.some((review) => review.pointId === row.point_id));
      return route.fulfill({ json: { counts: { total: 3042, empty: 3039 - reviews.length, pending: open.length, accepted: reviews.length, rework: 1 }, pending: open, rework } });
    }
    if (/\/playgrounds\/[^/]+\/photo$/.test(pathname)) return route.fulfill({ contentType: 'image/png', body: PNG });
    if (/\/playgrounds\/[^/]+\/review$/.test(pathname) && request.method() === 'POST') {
      reviews.push({ pointId: pathname.split('/').at(-2), ...request.postDataJSON() });
      return route.fulfill({ json: { status: request.postDataJSON().decision } });
    }
    if (pathname.endsWith('/playgrounds/report.xlsx')) return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from([0x50, 0x4b, 0x03, 0x04]) });
    return route.fulfill({ status: 404, json: {} });
  });
  return { reviews };
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`приёмка ДП и СП: фильтр вида, решение и переход к следующей ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { reviews } = await cabinet(page);
    await page.goto('http://127.0.0.1:8766/districts/review.html');
    await expect(page.locator('#counts')).toContainText('точек на проверке');
    await expect(page.getByLabel('Вид площадки')).toBeHidden();

    await page.getByRole('tab', { name: 'ДП и СП' }).click();
    await expect(page.locator('#counts')).toContainText('площадок на проверке');
    await expect(page.locator('#counts')).toContainText('3 042');
    await expect(page.locator('#list .object-row')).toHaveCount(2);
    await page.getByLabel('Вид площадки').selectOption('sp');
    await expect(page.locator('#list .object-row')).toHaveCount(1);
    await expect(page.locator('#list .object-row')).toContainText('Спортивная площадка');
    await page.getByLabel('Вид площадки').selectOption('');

    await page.locator('#list .object-row').first().click();
    await expect(page.locator('#objectTitle')).toHaveText('Детская площадка: Коптевская ул., 30');
    await expect(page.locator('#slotGrid img')).toHaveCount(1);
    await page.locator('#slotGrid').getByRole('button', { name: 'Принять' }).click();
    await expect(page.locator('#objectTitle')).toHaveText('Спортивная площадка: Коптевская ул., 32');
    expect(reviews).toEqual([{ pointId: 'pg-1', decision: 'accepted', comment: '' }]);

    await page.locator('#slotGrid').getByRole('button', { name: 'Отклонить' }).click();
    await page.locator('#slotGrid textarea').fill('Нет таблички с адресом');
    await page.locator('#slotGrid').getByRole('button', { name: 'Отправить на доработку' }).click();
    await expect.poll(() => reviews.length).toBe(2);
    expect(reviews[1]).toEqual({ pointId: 'pg-2', decision: 'rejected', comment: 'Нет таблички с адресом' });
  });
}

test('доработка ДП и СП показывает причину без запроса отклонённого снимка, свод скачивается', async ({ page }) => {
  await cabinet(page);
  await page.goto('http://127.0.0.1:8766/districts/review.html#playgrounds');
  await expect(page.getByRole('tab', { name: 'ДП и СП' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'На доработке' }).click();
  await page.locator('#list .object-row').first().click();
  await expect(page.locator('#slotGrid .comment')).toHaveText('Что исправить: Площадка не в кадре');
  await expect(page.locator('#slotGrid img')).toHaveCount(0);
  await page.getByRole('button', { name: 'К списку точек' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel: свод по фото' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('Svod_foto_DP_SP_SAO_2026-10-28.xlsx');
});
