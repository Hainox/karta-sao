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

test('ответственный ДП/СП видит назначенный район и не открывает приёмку', async ({ page }) => {
  await setup(page, false, null, async (route, path) => {
    if (path.endsWith('/auth/me')) {
      await route.fulfill({ json: { user: { role: 'dpsp_district_editor', displayName: 'Тест', district: 'Аэропорт' } } });
      return true;
    }
    return false;
  });
  await page.goto('http://127.0.0.1:8766/dp-sp-cabinet/');
  await expect(page.locator('#userLine')).toHaveText('Тест · Аэропорт');
  await expect(page.locator('#district')).toBeHidden();
  await page.locator('.account-menu summary').click();
  await expect(page.getByRole('link', { name: 'К приёмке' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Тестовая площадка/ })).toBeVisible();

  await page.goto('http://127.0.0.1:8766/dp-sp-review/');
  await expect(page.locator('#loginMsg')).toHaveText('Приёмка доступна только администратору.');
  await expect(page.locator('#main')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Сводка по оцифровке' })).toBeHidden();
});

test('сводка новой оцифровки считает закрытые площадки и выгружает весь округ', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let snapshotReads = 0;
  await setup(page, true, null, async (route, path) => {
    if (path.endsWith('/dictionaries')) {
      await route.fulfill({ json: { types: [], districts: [
        { name: 'Аэропорт' }, { name: 'Савеловский' }, { name: 'Сокол' },
      ] } });
    } else if (path.endsWith('/workflow/sheet.json')) {
      snapshotReads++;
      await route.fulfill({ json: { generated_at: '2026-11-23T21:25:00Z', sites: [
        { point_id: '1', district: 'Аэропорт', kind: 'dp', state: 'accepted' },
        { point_id: '2', district: 'Аэропорт', kind: 'sp', state: 'submitted' },
        { point_id: '3', district: 'Савёловский', kind: 'sp', state: 'accepted' },
        { point_id: '4', district: 'Савеловский', kind: 'dp', state: 'rework' },
        { point_id: '5', district: 'Савеловский', kind: 'dp', state: 'work' },
      ], photos: [{ point_id: '1' }, { point_id: '1' }] } });
    } else return false;
    return true;
  });
  await page.goto('http://127.0.0.1:8766/dp-sp-review/');
  await page.locator('#district').selectOption('Аэропорт');
  await page.getByRole('button', { name: 'Сводка по оцифровке' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сводка по оцифровке ДП и СП' });
  await expect(dialog.getByText('24.11.2026', { exact: false })).toBeVisible();
  const total = dialog.getByRole('row', { name: /^Итого по САО/ });
  await expect(total.getByRole('cell')).toHaveText(['5', '2', '1', '1', '1', '40 %']);
  await expect(dialog.getByRole('row', { name: /^Савеловский/ }).getByRole('cell')).toHaveText(['3', '1', '0', '1', '1', '33,33 %']);
  await expect(dialog.getByRole('row', { name: /^Сокол/ }).getByRole('cell')).toHaveText(['0', '0', '0', '0', '0', '—']);
  await dialog.getByLabel('Вид площадки в сводке').selectOption('sp');
  await expect(total.getByRole('cell')).toHaveText(['2', '1', '1', '0', '0', '50 %']);
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать Excel' }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('Сводка_оцифровки_ДП_СП_САО_2026-11-24.xlsx');
  expect(await file.failure()).toBeNull();
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Сводка по оцифровке' }).click();
  await expect(total.getByRole('cell')).toHaveText(['5', '2', '1', '1', '1', '40 %']);
  expect(snapshotReads).toBe(2);
});

test('оцифровка: после ошибки загрузки фото можно дозагрузить к сохранённому МАФ', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    navigator.geolocation.watchPosition = success => {
      queueMicrotask(() => success({ coords: { latitude: 55.81, longitude: 37.54 }, timestamp: Date.now() }));
      return 1;
    };
    navigator.geolocation.clearWatch = () => {};
    Object.defineProperty(window, 'DeviceOrientationEvent', {
      configurable: true,
      value: { requestPermission: async () => 'granted' },
    });
    window.testCompassSamples = 0;
    const addListener = window.addEventListener.bind(window);
    window.addEventListener = (event, handler, options) => {
      if (event === 'deviceorientationabsolute') {
        queueMicrotask(() => {
          handler({ absolute: true, alpha: 90, beta: 90, gamma: 0 });
          window.testCompassSamples += 1;
        });
      }
      return addListener(event, handler, options);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      const paint = () => ctx.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(10);
      paint();
      const timer = setInterval(() => {
        if (stream.getVideoTracks()[0].readyState === 'ended') clearInterval(timer);
        else paint();
      }, 100);
      return stream;
    };
  });
  const maf = { id: 'maf-created-after-photo-error', type_code: 'bench', type_label: 'Скамья', quantity: 1, condition: 'ok', photo_id: null };
  let created = false;
  let storedPhoto;
  let mafPosts = 0;
  let photoPuts = 0;
  await page.route('https://api-maps.yandex.ru/**', route => route.fulfill({
    contentType: 'text/javascript',
    body: `window.ymaps = {
      ready: resolve => resolve(),
      Map: class {
        container = { fitToViewport() {} };
        geoObjects = { add() {} };
        constructor(host, { center }) { host.textContent = center.join(', '); }
        destroy() {}
      },
      Placemark: class { events = { add() {} }; }
    };`,
  }));
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
      expect(route.request().headers()['content-type']).toBe('image/jpeg');
      if (photoPuts === 1) {
        await route.fulfill({ status: 503, json: { error: 'Тестовая ошибка загрузки фото' } });
      } else {
        storedPhoto = route.request().postDataBuffer();
        await route.fulfill({ json: {} });
      }
      return true;
    }
    if (path.endsWith(`/maf/${maf.id}/photo`) && route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'image/jpeg', body: storedPhoto });
      return true;
    }
    if (path.endsWith(`/object-photo-points/dpsp/sites/${id}`) && route.request().method() === 'GET') {
      await route.fulfill({ json: {
        site: { ...site, district_slug: 'aeroport', latitude: 55.8, longitude: 37.5 },
        items: created ? [{ ...maf, photo_id: storedPhoto ? 'saved-photo' : null }] : [],
      } });
      return true;
    }
    return false;
  });
  await page.goto('http://127.0.0.1:8766/dp-sp-cabinet/');
  await page.locator('.item').click();
  await expect(page.locator('#detail h2')).toHaveText(site.address);
  await expect(page.locator('.add-maf')).toHaveJSProperty('open', true);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await expect(page.locator('.site-map [data-map="map"]')).toHaveText('55.8, 37.5');
  await expect(page.getByRole('link', { name: 'Открыть на карте района' })).toHaveCount(0);
  await page.getByLabel('Тип МАФ').selectOption('bench');
  await page.getByRole('button', { name: 'Снять МАФ', exact: true }).click();
  await page.waitForFunction(() => window.testCompassSamples === 1);
  await page.getByRole('button', { name: 'Сделать снимок' }).click();
  await page.getByRole('button', { name: 'Добавить МАФ', exact: true }).click();

  await expect(page.locator('#message')).toContainText('МАФ сохранён, но фото не загружено');
  const mafCard = page.locator('.maf-item').filter({ hasText: 'Скамья × 1' });
  await expect(mafCard).toBeVisible();
  await mafCard.getByRole('button', { name: 'Снять МАФ' }).click();
  await page.waitForFunction(() => window.testCompassSamples === 2);
  await page.getByRole('button', { name: 'Сделать снимок' }).click();
  await expect(page.locator('#message')).toHaveText('Фото МАФ сохранено');
  await expect(page.locator('.site-map [data-map="map"]')).toHaveText('55.81, 37.54');
  await expect(page.locator('.map-photo-location')).toHaveText('Точка съёмки по GPS. Направление кадра 270°.');
  expect(mafPosts).toBe(1);
  expect(photoPuts).toBe(2);
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
        await expect(page.locator('.add-maf')).toHaveJSProperty('open', true);
        await expect(page.getByRole('button', { name: 'Снять МАФ', exact: true })).toBeVisible();
      }
    });
  }
}
