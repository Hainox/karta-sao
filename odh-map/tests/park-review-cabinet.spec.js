import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const base = '/api/object-photo-points/parks';
const mapPage = 'http://127.0.0.1:8766/districts/review.html';
const parks = [
  { id: 'dubki', name: 'Парк Дубки', district: 'Тимирязевский', asu_ids: ['970107243'], registry_status: 'matched' },
  { id: 'nearby', name: 'Соседний парк', district: 'Тимирязевский', asu_ids: [], registry_status: 'absent_in_source' },
  { id: 'foreign', name: 'Парк в другом районе', district: 'Ховрино', asu_ids: [], registry_status: 'unverified' },
];
function row(park, number, withPhoto = true) {
  return { point_id: 'frame-' + number, source_point_id: 'point-' + number, park_id: park.id,
    label: park.name, district: park.district, heading: 15, longitude: 37.566, latitude: 55.818,
    photo_id: withPhoto ? 'photo-' + number : null, uploaded_at: '2026-11-27T07:00:00Z' };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=', 'base64');

test('парки: фильтр по объекту, прежние статусы, приёмка и возврат снимка', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const queues = {
    pending: [row(parks[0], 1), row(parks[0], 2), row(parks[1], 3)],
    accepted: [{ ...row(parks[0], 4), reviewed_at: '2026-11-27T07:10:00Z' }],
    rework: [{ ...row(parks[0], 5), rejected_comment: 'Переснять по стрелке' }],
    empty: [row(parks[0], 6, false), row(parks[1], 7, false)],
  };
  const decisions = [];
  const totals = () => ({
    counts: { total: 7, ...Object.fromEntries(Object.entries(queues).map(([key, rows]) => [key, rows.length])) },
    parks,
    ...queues,
  });
  await page.addInitScript(() => sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' })));
  await page.route('**/api/object-photo-points/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === base + '/review/queue') return route.fulfill({ json: totals() });
    if (path.endsWith('/review') && req.method() === 'POST') {
      const { decision, comment } = req.postDataJSON();
      const index = queues.pending.findIndex(item => path.includes('/frames/' + item.point_id + '/photos/' + item.photo_id + '/'));
      expect(index).toBeGreaterThanOrEqual(0);
      const [item] = queues.pending.splice(index, 1);
      const reviewed_at = '2026-11-27T08:00:00Z';
      if (decision === 'accepted') queues.accepted.push({ ...item, reviewed_at });
      else queues.rework.push({ ...item, rejected_at: reviewed_at, rejected_comment: comment });
      decisions.push([item.point_id, decision]);
      return route.fulfill({ json: { photo: { id: item.photo_id, status: decision, reviewed_at } } });
    }
    if (path.startsWith(base + '/frames/')) return route.fulfill({ contentType: 'image/png', body: png });
    return route.fulfill({ json: { counts: { total: 0, pending: 0, accepted: 0, rework: 0, empty: 0 }, pending: [], rework: [] } });
  });
  await page.goto(mapPage + '#parks');
  await expect(page.getByRole('tab', { name: 'Парковые территории' })).toHaveAttribute('aria-selected', 'true');
  const progress = page.locator('#parkProgressLabel');
  await expect(progress).toHaveText('Принято 1 из 7 точек');
  await expect(page.getByRole('link', { name: 'Инструкция' })).toHaveAttribute('href', 'guides/park-review.html');
  const parkSearch = page.getByRole('searchbox', { name: 'Поиск парка' });
  await parkSearch.fill('970107243');
  await expect(progress).toHaveText('Принято 1 из 5 точек');
  await parkSearch.fill('несуществующий парк');
  await expect(page.getByText('Парки не найдены. Измените запрос или сбросьте фильтры.')).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
  await expect(parkSearch).toBeFocused();
  await expect(progress).toHaveText('Принято 1 из 7 точек');
  await page.getByRole('combobox', { name: 'Район' }).selectOption('Тимирязевский');
  const parkFilter = page.getByRole('combobox', { name: 'Парк', exact: true });
  await expect(parkFilter.locator('option')).toHaveCount(3);
  await parkFilter.selectOption('dubki');
  await expect(progress).toHaveText('Принято 1 из 5 точек');
  await expect(page.locator('#park-empty-count')).toHaveText('1');
  await expect(page.locator('#parkScopeTitle')).toHaveText('Парк Дубки');
  const update = page.waitForResponse(response => response.url().endsWith(base + '/review/queue'));
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await update;
  await expect(parkFilter).toHaveValue('dubki');
  await expect(page.locator('#parkUpdated')).toContainText('МСК');
  await expect(page.getByRole('button', { name: 'Архив фото (ZIP)' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const records = page.locator('#list .object-row');
  const back = page.getByRole('button', { name: /К списку точек/ });
  const pendingTab = page.getByRole('tab', { name: 'На проверке', exact: true });
  await pendingTab.focus();
  await pendingTab.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'На доработке', exact: true })).toBeFocused();
  await page.getByRole('tab', { name: 'На доработке', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Принято', exact: true })).toHaveAttribute('aria-selected', 'true');
  await records.first().click();
  await expect(page.locator('#objectTitle')).toHaveText('Парк Дубки');
  await expect(page.locator('#objectMeta')).toContainText('970107243');
  await expect(page.locator('#slotGrid img')).toBeVisible();
  await expect(page.locator('#objectMapLink')).toHaveAttribute('href', 'timiryazevskiy.html?parkPoint=point-4');
  await expect(page.getByRole('link', { name: 'Инструкция' })).toHaveAttribute('href', 'guides/park-review.html#check');
  await expect(page.locator('#acceptObject')).toBeHidden();
  await back.click();

  await page.getByRole('tab', { name: 'На доработке', exact: true }).click();
  await records.first().click();
  await expect(page.locator('#slotGrid .comment')).toHaveText('Что исправить: Переснять по стрелке');
  await back.click();
  await page.getByRole('tab', { name: 'Без фото', exact: true }).click();
  await records.first().click();
  await expect(page.locator('#objectStatus')).toHaveText('Фото точки ещё не загружено.');
  await expect(page.locator('#acceptObject')).toBeHidden();
  await back.click();

  await page.getByRole('tab', { name: 'На проверке', exact: true }).click();
  await expect(records).toHaveCount(2);
  await records.first().click();
  await page.getByRole('button', { name: 'Принять кадр', exact: true }).click();
  await expect(page.locator('#objectMapLink')).toHaveAttribute('href', 'timiryazevskiy.html?parkPoint=point-2');
  await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await page.locator('.reject-form textarea').fill('Проверить ракурс');
  await page.getByRole('button', { name: 'Отправить на доработку' }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#park-pending-count')).toHaveText('0');
  await expect(page.locator('#park-accepted-count')).toHaveText('2');
  await expect(page.locator('#park-rework-count')).toHaveText('2');
  expect(decisions).toEqual([['frame-1', 'accepted'], ['frame-2', 'rejected']]);

  await parkFilter.selectOption('nearby');
  await expect(records.first()).toContainText('По списку отсутствует в АСУ ОДС');
  await page.getByRole('tab', { name: 'Без фото', exact: true }).click();
  await page.getByRole('tab', { name: 'ДТС', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'На проверке', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Без фото', exact: true })).toBeHidden();
});

test('инструкция открывается из парковой вкладки и возвращает в неё', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' })));
  await page.route('**/api/object-photo-points/**', route => route.fulfill({
    json: { parks: [], counts: { total: 0, pending: 0, rework: 0, accepted: 0, empty: 0 }, pending: [], rework: [], accepted: [], empty: [] },
  }));
  await page.goto(mapPage + '#parks');
  const popup = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Инструкция' }).click();
  const guide = await popup;
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('Как принимать фотографии парков');
  await guide.getByRole('link', { name: 'Проверка и решение' }).click();
  await expect(guide).toHaveURL(/park-review\.html#check$/);
  await guide.getByRole('link', { name: /В кабинет приёмки парков/ }).first().click();
  await expect(guide).toHaveURL(mapPage + '#parks');
});

test('сводка парков считает статусы, показывает парк без точек и выгружает выборку', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date('2026-11-27T09:30:00Z'));
  await page.addInitScript(() => sessionStorage.setItem('odh-map-api-user-v1', JSON.stringify({ role: 'prefecture_admin' })));
  const queue = {
    parks, counts: { total: 4, pending: 1, accepted: 1, rework: 1, empty: 1 },
    pending: [row(parks[1], 2)],
    accepted: [row(parks[0], 1)],
    rework: [{ ...row(parks[0], 3), rejected_comment: 'Переснять с аллеи & сравнить', rejected_at: '2026-11-27T08:00:00Z' }],
    empty: [row(parks[0], 4, false)],
  };
  let reads = 0;
  await page.route('**/api/object-photo-points/parks/review/queue', route => {
    reads++;
    return route.fulfill({ json: queue });
  });
  await page.goto(mapPage + '#parks');
  await expect(page.locator('#parkProgressLabel')).toHaveText('Принято 1 из 4 точек');
  await page.getByRole('button', { name: 'Сводка по оцифровке' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сводка по оцифровке парков' });
  const reportRows = dialog.locator('tbody tr');
  await expect(reportRows.first().getByRole('cell')).toHaveText(['Итого по САО', '3', '1', '4', '1', '1', '1', '1', '25 %']);
  await dialog.getByRole('combobox', { name: 'Разрез' }).selectOption({ label: 'По паркам' });
  const zero = reportRows.filter({ hasText: parks[2].name });
  await expect(zero.getByRole('cell')).toHaveText(['Ховрино', parks[2].name, 'Не подтверждён', '0', '0', '0', '0', '0', '—']);
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('searchbox', { name: 'Поиск парка' }).fill('970107243');
  await page.getByRole('combobox', { name: 'Парк', exact: true }).selectOption('dubki');
  await page.getByRole('button', { name: 'Сводка по оцифровке' }).click();
  await expect(dialog.getByRole('status')).toContainText('Парк Дубки · Поиск «970107243»');
  await expect(reportRows.nth(1).getByRole('cell')).toHaveText(['Тимирязевский', 'Парк Дубки', '970107243', '3', '1', '0', '1', '1', '33,33 %']);
  expect(reads).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать Excel' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Сводка_оцифровки_парков_САО_2026-11-27.xlsx');
  const data = await readFile(await download.path());
  expect(data.readUInt32LE()).toBe(0x04034b50);
  expect(data.includes(Buffer.from('timiryazevskiy.html?parkPoint=point-3'))).toBe(true);
  expect(data.includes(Buffer.from('Переснять с аллеи &amp; сравнить'))).toBe(true);
  expect(data.includes(Buffer.from('Соседний парк'))).toBe(false);
});
