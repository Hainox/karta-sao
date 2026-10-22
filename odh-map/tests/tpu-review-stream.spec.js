import { test, expect } from '@playwright/test';

async function cabinet(page, { slots = 2, count = 2, wideImage = false, missing = false } = {}) {
  const objects = Array.from({ length: count }, (_, i) => ({ id: `tpu:test-${i}`, label: `Тестовый объект ${i + 1}`, group: 'Коптево', kind: 'tpu', type: 'ТПУ', required: slots }));
  const photos = objects.flatMap(object => Array.from({ length: slots }, (_, i) => ({ id: `${object.id}-photo-${i}`, objectId: object.id, slot: i + 1, status: 'pending', uploaded_at: '2026-10-20T12:00:00Z' })));
  if (missing) photos[slots - 1].status = 'missing';
  const control = { writes: 0, failWrite: 0, failQueue: false, delayPhoto: false, failDetail: false, delayQueue: 0 };
  await page.addInitScript(() => sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' })));
  await page.route('**/api/object-photo-points/slots/**', async route => {
    const request = route.request();
    const pathname = decodeURIComponent(new URL(request.url()).pathname);
    if (pathname.endsWith('/queue')) {
      if (control.delayQueue) await new Promise(resolve => setTimeout(resolve, control.delayQueue));
      if (control.failQueue) return route.fulfill({ status: 503, json: { error: 'Очередь временно недоступна' } });
      const rows = status => photos.filter(photo => photo.status === status).map(photo => ({ ...photo, object: objects.find(object => object.id === photo.objectId) }));
      return route.fulfill({ json: { pending: rows('pending'), rework: rows('rejected'), counts: { closed: 0, progress: 0, empty: 0 } } });
    }
    const object = objects.find(object => pathname.endsWith('/objects/' + object.id));
    if (object) {
      if (control.failDetail) return route.fulfill({ status: 503, json: { error: 'Объект временно недоступен' } });
      const own = photos.filter(photo => photo.objectId === object.id);
      return route.fulfill({ json: { required: slots, accepted: own.filter(photo => photo.status === 'accepted').length, status: 'review', slots: own.map(photo => ({ slot: photo.slot, photo: ['rejected', 'missing'].includes(photo.status) ? null : photo, rejected: photo.status === 'rejected' ? photo : null })) } });
    }
    const photo = photos.find(photo => pathname.includes('/photos/' + photo.id));
    if (photo && request.method() === 'POST') {
      control.writes++;
      if (control.writes === control.failWrite) return route.fulfill({ status: 503, json: { error: 'Решение не сохранено' } });
      const body = request.postDataJSON();
      photo.status = body.decision; photo.review_comment = body.comment;
      return route.fulfill({ json: { ok: true } });
    }
    if (photo) {
      if (wideImage) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#f2b544"/><rect width="240" height="400" fill="#164e63"/><text x="300" y="220" font-size="60">TEST 800x400</text></svg>' });
      if (control.delayPhoto) await new Promise(resolve => setTimeout(resolve, 200));
      return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=', 'base64') });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('http://127.0.0.1:8766/object-maps/tpu-review.html');
  await page.getByRole('combobox', { name: 'Район', exact: true }).selectOption('Коптево');
  await page.getByRole('combobox', { name: 'Вид объекта', exact: true }).selectOption('tpu');
  await page.getByRole('button', { name: /Тестовый объект 1/ }).click();
  await expect(page.locator('#slotGrid .card')).toHaveCount(slots);
  return control;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`поток одиночной, массовой приёмки и возврата ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const control = await cabinet(page, { count: 3 });
    await page.getByRole('button', { name: 'Принять', exact: true }).first().click();
    await expect(page.locator('#objectStatus')).toContainText('принято 1 из 2');
    await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 1');
    await page.getByRole('button', { name: 'Принять', exact: true }).click();
    await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 2');
    await page.screenshot({ path: testInfo.outputPath('acceptance-stream.png'), fullPage: true });
    await page.getByRole('button', { name: 'Принять объект' }).click();
    await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 3');
    await page.getByRole('button', { name: 'Принять', exact: true }).first().click();
    await expect(page.locator('#objectStatus')).toContainText('принято 1 из 2');
    await page.locator('.card').filter({ has: page.getByRole('button', { name: 'Принять', exact: true }) }).getByRole('button', { name: 'Отклонить' }).click();
    await page.locator('textarea:visible').fill('Нужен общий план');
    await page.getByRole('button', { name: 'Отправить на доработку' }).click();
    await expect(page.locator('#listStatus')).toHaveText('Все объекты в выбранной очереди проверены.');
    await expect(page.getByRole('combobox', { name: 'Район', exact: true })).toHaveValue('Коптево');
    await expect(page.getByRole('combobox', { name: 'Вид объекта', exact: true })).toHaveValue('tpu');
    expect(control.writes).toBe(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('ошибка очереди после сохранения: повтор перехода без второго POST', async ({ page }) => {
  const control = await cabinet(page, { slots: 1 });
  control.failQueue = true;
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#objectStatus')).toContainText('Решение сохранено.');
  await expect(page.locator('#objectStatus')).toContainText('Очередь временно недоступна');
  control.failQueue = false;
  await page.getByRole('button', { name: 'Следующий объект' }).click();
  await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 2');
  expect(control.writes).toBe(1);
});

test('частично сохранённая массовая приёмка не скрывает ошибку', async ({ page }) => {
  const control = await cabinet(page);
  control.failWrite = 2;
  await page.getByRole('button', { name: 'Принять объект' }).click();
  await expect(page.locator('#objectStatus')).toContainText('Решение не сохранено');
  await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 1');
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 2');
  expect(control.writes).toBe(3);
});

test('ошибка записи оставляет фото доступным для повторной проверки', async ({ page }) => {
  const control = await cabinet(page, { slots: 1 });
  control.failWrite = 1;
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#objectStatus')).toContainText('Решение не сохранено');
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeEnabled();
  await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 1');
});

test('сохранение успешно, карточка недоступна: повтор восстанавливает поток', async ({ page }) => {
  const control = await cabinet(page, { slots: 1 });
  control.failDetail = true;
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#objectStatus')).toContainText('Решение сохранено.');
  await expect(page.getByRole('button', { name: 'Повторить загрузку объекта' })).toBeVisible();
  control.failDetail = false;
  await page.getByRole('button', { name: 'Повторить загрузку объекта' }).click();
  await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 2');
  expect(control.writes).toBe(1);
});

test('во время перехода новые кнопки блокируются', async ({ page }) => {
  const control = await cabinet(page, { slots: 1 });
  control.delayQueue = 1500;
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#nextObject')).toBeVisible();
  await expect(page.locator('#nextObject')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Отклонить', exact: true })).toBeDisabled();
  await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 2');
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeEnabled();
});

test('выход во время загрузки очереди не возвращает кабинет', async ({ page }) => {
  const control = await cabinet(page, { slots: 1 });
  control.delayQueue = 300;
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#nextObject')).toBeVisible();
  const reply = page.waitForResponse(response => response.url().endsWith('/slots/queue'));
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await reply;
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#objectView')).toBeHidden();
  await expect(page.locator('#workspace')).toBeHidden();
  expect(control.writes).toBe(1);
});

for (const width of [1280, 390]) {
  test(`поворот фото в карточке и увеличенном просмотре ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    const control = await cabinet(page, { wideImage: true });
    const panel = page.locator('.photo-panel').first();
    const image = panel.locator('img');
    await expect(image).toBeVisible();
    const source = await image.getAttribute('src');
    await panel.getByRole('button', { name: 'Повернуть вправо' }).click();
    await expect(image).toHaveAttribute('src', source);
    await expect(panel.locator('.photo-angle')).toHaveText('90°');
    await expect(page.locator('.photo-panel').nth(1).locator('.photo-angle')).toHaveText('0°');
    await panel.getByRole('link').click();
    const viewer = page.getByRole('dialog', { name: 'Слот 1' });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.photo-angle')).toHaveText('90°');
    await viewer.getByRole('button', { name: 'Повернуть влево' }).click();
    await expect(viewer.locator('.photo-angle')).toHaveText('0°');
    for (let i = 0; i < 4; i++) await viewer.getByRole('button', { name: 'Повернуть вправо' }).click();
    await expect(viewer.locator('.photo-angle')).toHaveText('0°');
    await viewer.getByRole('button', { name: 'Повернуть вправо' }).click();
    const fits = await viewer.locator('img').evaluate(img => {
      const rect = img.getBoundingClientRect(), frame = img.parentElement.getBoundingClientRect();
      return rect.left >= frame.left - 1 && rect.right <= frame.right + 1 && rect.top >= frame.top - 1 && rect.bottom <= frame.bottom + 1;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('photo-rotation.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(panel.getByRole('link')).toBeFocused();
    await expect(panel.locator('.photo-angle')).toHaveText('90°');
    expect(control.writes).toBe(0);
    await page.getByRole('button', { name: 'Принять', exact: true }).last().click();
    await expect(page.locator('#objectStatus')).toContainText('принято 1 из 2');
    await expect(page.locator('.photo-panel').first().locator('.photo-angle')).toHaveText('90°');
    await page.locator('.photo-panel').first().getByRole('button', { name: 'Сбросить поворот' }).click();
    await expect(page.locator('.photo-panel').first().locator('.photo-angle')).toHaveText('0°');
    expect(control.writes).toBe(1);
  });
}

test('принять объект принимает одно оставшееся фото и продолжает очередь', async ({ page }) => {
  const control = await cabinet(page, { slots: 1 });
  await page.getByRole('button', { name: 'Принять объект', exact: true }).click();
  await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 2');
  expect(control.writes).toBe(1);
});

test('незаполненный объект нельзя объявить выполненным', async ({ page }) => {
  const control = await cabinet(page, { missing: true });
  await expect(page.getByRole('button', { name: 'Принять объект', exact: true })).toBeDisabled();
  await expect(page.locator('#acceptObjectHint')).toContainText('во все обязательные слоты');
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.locator('#objectTitle')).toHaveText('Тестовый объект 2');
  expect(control.writes).toBe(1);
});
