import { test, expect } from '@playwright/test';

const id = '03500000-2026-4116-8116-000000000001';
const site = { point_id: id, source_id: 'QA-MOBILE', address: 'Тестовая площадка с длинным адресом, 123', district: 'Аэропорт', kind: 'dp' };

async function setup(page, review, decisionHandler, requestHandler) {
  await page.addInitScript(() => localStorage.setItem('saoPhotoToken', 'test-only'));
  await page.route('https://obhod-sao.ru/photo-api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (requestHandler && await requestHandler(route, path)) return;
    let body;
    if (path.endsWith('/auth/me')) body = { user: { role: 'prefecture_admin', displayName: 'Тест' } };
    else if (path.endsWith('/dictionaries')) body = { types: [], districts: [{ name: 'Аэропорт' }] };
    else if (path.endsWith('/decision')) {
      if (decisionHandler) return decisionHandler(route);
      return route.fulfill({ status: 503, json: { error: 'Тестовая ошибка связи' } });
    }
    else if (path.endsWith('/workflow/sites')) body = { sites: [site] };
    else if (path.includes('/workflow/sites/')) body = { photos: [], workflow: review ? { state: 'submitted' } : null };
    else body = { site, items: [] };
    return route.fulfill({ json: body });
  });
}

test('приёмка: Back во время сохранения не возвращает карточку после ответа', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  let startDecision;
  const decisionStarted = new Promise(resolve => { startDecision = resolve; });
  let releaseDecision;
  const decisionResponse = new Promise(resolve => { releaseDecision = resolve; });
  let queueReads = 0;
  let startReload;
  const reloadStarted = new Promise(resolve => { startReload = resolve; });
  let releaseReload;
  const reloadResponse = new Promise(resolve => { releaseReload = resolve; });
  await setup(page, true, async route => {
    startDecision();
    await decisionResponse;
    return route.fulfill({ json: { workflow: { state: 'accepted' } } });
  }, async (route, path) => {
    if (path.endsWith('/workflow/sites') && route.request().method() === 'GET' && ++queueReads > 1) {
      startReload();
      await reloadResponse;
      await route.fulfill({ json: { sites: [site] } });
      return true;
    }
    return false;
  });
  await page.goto('http://127.0.0.1:8766/dp-sp-review/');
  await page.locator('.item').click();
  await expect(page.locator('#detail h2')).toHaveText(site.address);

  await page.getByRole('button', { name: 'Принять объект' }).click();
  await decisionStarted;
  await page.goBack();
  await expect(page.locator('.queue')).toBeVisible();
  const listHistoryLength = await page.evaluate(() => history.length);

  releaseDecision();
  await reloadStarted;
  await page.goForward();
  await expect(page.locator('.queue')).toBeHidden();
  await page.goBack();
  await expect(page.locator('.queue')).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(listHistoryLength);
  releaseReload();
  await expect(page.locator('#message')).toHaveText('Объект принят');
  await expect(page.locator('.queue')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/card-open/);
  expect(await page.evaluate(() => history.state?.cabinetSite ?? null)).toBeNull();
  expect(await page.evaluate(() => history.length)).toBe(listHistoryLength);
});

test('оцифровка: смена desktop/mobile сохраняет выбранный экран после Back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await setup(page, false);
  await page.goto('http://127.0.0.1:8766/dp-sp-cabinet/');
  await page.locator('.item').click();
  await expect(page.locator('#detail h2')).toHaveText(site.address);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.queue')).toBeHidden();
  await expect(page.locator('#detail')).toBeVisible();
  await page.getByRole('button', { name: 'К списку', exact: true }).click();
  await expect(page.locator('.queue')).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator('.queue')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.queue')).toBeVisible();
  await expect(page.locator('#detail')).toBeHidden();
  expect(await page.evaluate(() => history.state?.cabinetSite ?? null)).toBeNull();
});

test('оцифровка: после ошибки загрузки фото можно дозагрузить к сохранённому МАФ', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const maf = { id: 'maf-created-after-photo-error', type_code: 'bench', type_label: 'Скамья', quantity: 1, condition: 'ok', photo_id: null };
  let created = false;
  let mafPosts = 0;
  let photoPuts = 0;
  await setup(page, false, null, async (route, path) => {
    if (path.endsWith('/dictionaries')) {
      await route.fulfill({ json: { types: [{ code: 'bench', label: 'Скамья' }], districts: [{ name: 'Аэропорт' }] } });
      return true;
    }
    if (path.endsWith(`/sites/${id}/maf`) && route.request().method() === 'POST') {
      mafPosts += 1;
      created = true;
      await route.fulfill({ json: { id: maf.id } });
      return true;
    }
    if (path.endsWith(`/maf/${maf.id}/photo`) && route.request().method() === 'PUT') {
      photoPuts += 1;
      await route.fulfill({ status: 503, json: { error: 'Тестовая ошибка загрузки фото' } });
      return true;
    }
    if (path.endsWith(`/object-photo-points/dpsp/sites/${id}`) && route.request().method() === 'GET') {
      await route.fulfill({ json: { site, items: created ? [maf] : [] } });
      return true;
    }
    return false;
  });
  await page.goto('http://127.0.0.1:8766/dp-sp-cabinet/');
  await page.locator('.item').click();
  await expect(page.locator('#detail h2')).toHaveText(site.address);
  await page.locator('.add-maf summary').click();
  await page.getByLabel('Тип МАФ').selectOption('bench');
  await page.getByLabel('Фото МАФ', { exact: true }).setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64')
  });
  await page.getByRole('button', { name: 'Добавить МАФ', exact: true }).click();

  await expect(page.locator('#message')).toContainText('МАФ сохранён, но фото не загружено');
  const mafCard = page.locator('.maf-item').filter({ hasText: 'Скамья × 1' });
  await expect(mafCard).toBeVisible();
  await expect(mafCard.getByRole('button', { name: 'Добавить фото' })).toBeVisible();
  expect(mafPosts).toBe(1);
  expect(photoPuts).toBe(1);
});

for (const review of [false, true]) {
  for (const width of [360, 390, 430, 768, 1280]) {
    test(`${review ? 'приёмка' : 'оцифровка'}: навигация и ширина ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await setup(page, review);
      await page.goto(`http://127.0.0.1:8766/${review ? 'dp-sp-review' : 'dp-sp-cabinet'}/`);
      await page.locator('.item').click();
      await expect(page.locator('#detail h2')).toHaveText(site.address);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width <= 760) {
        await expect(page.locator('.queue')).toBeHidden();
        await page.getByRole('button', { name: 'К списку', exact: true }).click();
        await expect(page.locator('.queue')).toBeVisible();
        await page.goForward();
        await expect(page.locator('#detail')).toBeVisible();
        await expect(page.locator('.queue')).toBeHidden();
      }
      if (review) {
        const reason = page.getByRole('textbox', { name: 'Причина возврата на доработку' });
        await reason.fill('Сохранить эту причину после ошибки');
        await page.getByRole('button', { name: 'Вернуть на доработку' }).click();
        await expect(page.locator('#message')).toHaveText('Тестовая ошибка связи');
        await expect(reason).toHaveValue('Сохранить эту причину после ошибки');
      } else {
        await page.locator('.add-maf summary').click();
        await expect(page.getByLabel('Фото МАФ', { exact: true })).toBeVisible();
      }
    });
  }
}
