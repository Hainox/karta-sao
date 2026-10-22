import { test, expect } from '@playwright/test';

// Кабинет приёмки фото районных точек (districts/review.html): по одному слоту
// на точку, бесконечный поток после решения, сохранение фильтров при переходе,
// поворот фото в карточке и в увеличенном просмотре.

async function cabinet(page, { count = 3, rework = 1, accepted = 1, empty = 0 } = {}) {
  const points = Array.from({ length: count }, (_, i) => ({
    point_id: `point-${i + 1}`, label: `1.${i + 1}`, district: i % 2 ? 'Коптево' : 'Аэропорт',
    heading: 45 + i * 30, longitude: 37.53 + i * 0.001, latitude: 55.81,
  }));
  const photos = points.map((point, i) => ({
    id: `photo-${i + 1}`, pointId: point.point_id, status: 'pending', uploaded_at: `2026-10-21T1${i}:00:00Z`,
  }));
  const rejected = Array.from({ length: rework }, (_, i) => ({
    id: `photo-rejected-${i + 1}`, pointId: `rework-${i + 1}`, status: 'rejected',
    uploaded_at: '2026-10-20T09:00:00Z', rejected_comment: 'Снимок без всходов', rejected_at: '2026-10-21T16:00:00Z',
  }));
  const control = { writes: 0, failWrite: 0, failQueue: false, delayQueue: 0 };
  await page.addInitScript(() => sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' })));
  await page.route('**/api/object-photo-points/**', async route => {
    const request = route.request();
    const pathname = decodeURIComponent(new URL(request.url()).pathname);
    if (pathname.endsWith('/district-photos/queue')) {
      if (control.delayQueue) await new Promise(resolve => setTimeout(resolve, control.delayQueue));
      if (control.failQueue) return route.fulfill({ status: 503, json: { error: 'Очередь временно недоступна' } });
      const queueRow = ({ photo, ...rest }) => ({ district: 'Аэропорт', heading: 45, longitude: 37.53, latitude: 55.81, ...rest, ...photo && { photo_id: photo.id, uploaded_at: photo.uploaded_at, photo_filename: 'test.png' }, ...photo?.status === 'rejected' && { rejected_comment: photo.rejected_comment, rejected_at: photo.rejected_at } });
      const pending = photos.filter(photo => photo.status === 'pending').map(photo => queueRow({ photo, point_id: photo.pointId, label: points.find(p => p.point_id === photo.pointId)?.label || photo.pointId.replace('point-', '1.'), district: 'Аэропорт' }));
      const reworkRows = (reworkPhotos) => reworkPhotos.map(photo => queueRow({ photo, point_id: photo.pointId, label: '2.1', district: 'Коптево', heading: 120 }));
      return route.fulfill({ json: {
        counts: { total: count + rework + accepted + empty, empty, pending: pending.length, accepted, rework: reworkRows(rejected).length },
        pending, rework: reworkRows(rejected),
      } });
    }
    if (pathname.endsWith('/review') && request.method() === 'POST') {
      control.writes++;
      if (control.writes === control.failWrite) return route.fulfill({ status: 503, json: { error: 'Решение не сохранено' } });
      const body = request.postDataJSON();
      const photo = photos.find(photo => pathname.includes('/photos/' + photo.id)) || rejected.find(photo => pathname.includes('/photos/' + photo.id));
      photo.status = body.decision;
      if (body.comment) { photo.rejected_comment = body.comment; photo.rejected_at = '2026-10-22T10:00:00Z'; }
      return route.fulfill({ json: { photo } });
    }
    if (pathname.includes('/photos/') && request.method() === 'GET') {
      if (pathname.includes('photo-rejected-1')) return route.fulfill({ status: 404, json: {} });
      return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=', 'base64') });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('http://127.0.0.1:8766/districts/review.html');
  await expect(page.locator('#counts')).toContainText('точек на проверке');
  await page.getByRole('combobox', { name: 'Район', exact: true }).selectOption('Аэропорт');
  await page.locator('#list .object-row').first().click();
  await expect(page.locator('#slotGrid .card')).toHaveCount(1);
  return control;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`поток приёмки районных точек и возврат на доработку ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const control = await cabinet(page, { count: 3, rework: 0, accepted: 0, empty: 0 });
    await expect(page.locator('#objectTitle')).toHaveText('Точка съёмки 1.1');
    await page.getByRole('button', { name: 'Принять', exact: true }).click();
    await expect(page.locator('#objectTitle')).toHaveText('Точка съёмки 1.2');
    await page.screenshot({ path: testInfo.outputPath('district-stream.png'), fullPage: true });
    await page.getByRole('button', { name: 'Принять объект', exact: true }).click();
    await expect(page.locator('#objectTitle')).toHaveText('Точка съёмки 1.3');
    await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
    await page.locator('textarea:visible').fill('Снимок не по стрелке направления');
    await page.getByRole('button', { name: 'Отправить на доработку' }).click();
    await expect(page.locator('#listStatus')).toHaveText('Все точки в выбранной очереди проверены.');
    await expect(page.getByRole('combobox', { name: 'Район', exact: true })).toHaveValue('Аэропорт');
    expect(control.writes).toBe(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('ошибка очереди после сохранения: повтор перехода без второго POST', async ({ page }) => {
  const control = await cabinet(page, { count: 2, rework: 0, accepted: 0, empty: 0 });
  control.failQueue = true;
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#objectStatus')).toContainText('Решение сохранено.');
  await expect(page.locator('#objectStatus')).toContainText('Очередь временно недоступна');
  control.failQueue = false;
  await page.getByRole('button', { name: 'Повторить загрузку точки' }).click();
  await expect(page.locator('#objectStatus')).toContainText('Снимок этой точки уже проверен');
  await page.getByRole('button', { name: 'Следующая точка' }).click();
  await expect(page.locator('#objectTitle')).toHaveText('Точка съёмки 1.2');
  expect(control.writes).toBe(1);
});

test('ошибка записи оставляет фото доступным для повторной проверки', async ({ page }) => {
  const control = await cabinet(page, { count: 2, rework: 0, accepted: 0, empty: 0 });
  control.failWrite = 1;
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#objectStatus')).toContainText('Решение не сохранено');
  await expect(page.locator('#objectTitle')).toHaveText('Точка съёмки 1.1');
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeEnabled();
});

test('вкладка доработки показывает комментарий префектуры', async ({ page }) => {
  await cabinet(page);
  await page.getByRole('button', { name: 'К списку точек' }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await page.locator('.tab[data-tab="rework"]').click();
  await page.getByRole('combobox', { name: 'Район', exact: true }).selectOption('Коптево');
  await page.locator('#list .object-row').first().click();
  await expect(page.locator('#objectTitle')).toHaveText('Точка съёмки 2.1');
  await expect(page.locator('#slotGrid .comment')).toContainText('Что исправить: Снимок без всходов');
  await expect(page.locator('#acceptObject')).toBeHidden();
});

for (const width of [1280, 390]) {
  test(`поворот фото в карточке и увеличенном просмотре ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    const control = await cabinet(page, { count: 1, rework: 0, accepted: 0, empty: 0 });
    const panel = page.locator('.photo-panel').first();
    const image = panel.locator('img');
    await expect(image).toBeVisible();
    const source = await image.getAttribute('src');
    await page.locator('.photo-panel').getByRole('button', { name: 'Повернуть вправо' }).click();
    await expect(image).toHaveAttribute('src', source);
    await expect(panel.locator('.photo-angle')).toHaveText('90°');
    await panel.locator('a.photo').click();
    const viewer = page.getByRole('dialog');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.photo-angle')).toHaveText('90°');
    await viewer.getByRole('button', { name: 'Повернуть влево' }).click();
    await expect(viewer.locator('.photo-angle')).toHaveText('0°');
    const fits = await viewer.locator('img').evaluate(img => {
      const rect = img.getBoundingClientRect(), frame = img.parentElement.getBoundingClientRect();
      return rect.left >= frame.left - 1 && rect.right <= frame.right + 1 && rect.top >= frame.top - 1 && rect.bottom <= frame.bottom + 1;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('district-rotation.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    expect(control.writes).toBe(0);
    await page.getByRole('button', { name: 'Принять объект', exact: true }).click();
    await expect(page.locator('#listStatus')).toContainText('Все точки');
  });
}
