import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  filterMkdRecords, MKD_PHOTO_LIMIT, mkdCanView, mkdCanWrite, mkdCounters, mkdCounterText, mkdFilesToSend, mkdLimitText,
  mkdPhotoCount, mkdStatusKey,
} from './mkd-model.js';

const records = [
  { id: 'injob:1', label: 'Балтийская ул., 6 · подъезд 1', group: 'Сокол', lat: 55.8, lon: 37.5 },
  { id: 'injob:2', label: 'Балтийская ул., 6 · подъезд 2', group: 'Сокол', lat: 55.8, lon: 37.5 },
  { id: 'injob:3', label: 'Ленинградский пр., 60 · подъезд 1', group: 'Аэропорт', lat: 55.8, lon: 37.5 },
];
const summary = { points: { 'injob:1': 3 } };

test('роли: пишет только отдел МКД, префектура только смотрит', () => {
  assert.equal(mkdCanWrite({ role: 'mkd_editor' }), true);
  assert.equal(mkdCanWrite({ role: 'prefecture_admin' }), false);
  assert.equal(mkdCanView({ role: 'prefecture_admin' }), true);
  assert.equal(mkdCanView({ role: 'district_editor', district: 'Сокол' }), false);
  assert.equal(mkdCanView(null), false);
});

test('статус подъезда — есть ли хоть одно фото первого этажа', () => {
  assert.equal(mkdPhotoCount(summary, 'injob:1'), 3);
  assert.equal(mkdPhotoCount(summary, 'injob:2'), 0);
  assert.equal(mkdPhotoCount(null, 'injob:1'), 0);
  assert.equal(mkdStatusKey(summary, 'injob:1'), 'with');
  assert.equal(mkdStatusKey(summary, 'injob:2'), 'without');
});

test('фильтр по району, поиску и наличию фото', () => {
  assert.deepEqual(filterMkdRecords(records, { district: 'сокол', summary }).map((r) => r.id), ['injob:1', 'injob:2']);
  assert.deepEqual(filterMkdRecords(records, { status: 'without', summary }).map((r) => r.id), ['injob:2', 'injob:3']);
  assert.deepEqual(filterMkdRecords(records, { status: 'with', summary }).map((r) => r.id), ['injob:1']);
  assert.deepEqual(filterMkdRecords(records, { query: 'ленинградский', summary }).map((r) => r.id), ['injob:3']);
});

test('счётчик считает подъезды, а не фото', () => {
  const counters = mkdCounters(records, summary);
  assert.deepEqual(counters, { total: 3, withPhoto: 1, without: 2, photos: 3, percent: 33 });
  assert.match(mkdCounterText(counters), /С фото первого этажа: 1 из 3 \(33 %\) · осталось: 2 · всего фото: 3/);
  assert.equal(mkdCounters([], summary).percent, 0);
});

test('лимит — десять фото на подъезд', () => {
  assert.equal(MKD_PHOTO_LIMIT, 10);
  assert.equal(mkdFilesToSend(4, 0), 4);
  assert.equal(mkdFilesToSend(4, 8), 2);
  assert.equal(mkdFilesToSend(4, 10), 0);
  assert.match(mkdLimitText(3), /Прикреплено 3 из 10 фото · можно добавить ещё 7/);
  assert.match(mkdLimitText(10), /это предел/);
});

test('страница МКД ходит только в раздел /mkd/ и не трогает фотофиксацию', async () => {
  const client = await readFile(new URL('./mkd-client.js', import.meta.url), 'utf8');
  const paths = [...client.matchAll(/(?:api|apiJson)\(`?'?(\/[a-z./-]+)/g)].map((match) => match[1]);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    assert.ok(path.startsWith('/mkd/') || path.startsWith('/auth/'), `лишняя ручка ${path}`);
  }
  assert.ok(!/\/reports\/summary|\/photos\?datasetId/.test(client));
});

test('основная страница уводит учётку МКД на её страницу', async () => {
  const client = await readFile(new URL('./photo-client.js', import.meta.url), 'utf8');
  assert.match(client, /user\?\.role === 'mkd_editor'[\s\S]{0,200}mkd\.html/);
});
