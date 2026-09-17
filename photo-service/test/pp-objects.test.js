import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPpRecords, majorityDistrict, ppReportKey } from '../src/pp-objects.js';

const record = (odhId, latitude, longitude) => ({
  id: `pp:${latitude}:${odhId}`,
  lat: latitude,
  lon: longitude,
  properties: { odh_id: odhId },
});

test('один odh_id — один объект, район по большинству точек', () => {
  // Один переход улицы: две записи в Коптево, одна за границей — объект целиком
  // остаётся в Коптево, второго ПП у соседа не появляется.
  const groups = groupPpRecords([
    record(10002198, 55.87, 37.55),
    record(10002198, 55.873, 37.539),
    record(10002198, 55.875, 37.54),
  ], (row) => (row.lat > 55.874 ? 'Тимирязевский' : 'Коптево'));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].odhId, '10002198');
  assert.equal(groups[0].district, 'Коптево');
  assert.equal(groups[0].records.length, 3);
});

test('разные объекты не смешиваются', () => {
  const groups = groupPpRecords([
    record(1, 55.87, 37.55),
    record(2, 55.88, 37.56),
    record(1, 55.871, 37.551),
  ], () => 'Коптево');

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.records.length), [2, 1]);
});

test('при равенстве голосов район важнее «без района»', () => {
  const groups = groupPpRecords([
    record(7, 55.87, 37.55),
    record(7, 55.99, 37.99),
  ], (row) => (row.lat > 55.9 ? null : 'Сокол'));

  assert.equal(groups[0].district, 'Сокол');
});

test('объект вне всех полигонов остаётся без района', () => {
  const groups = groupPpRecords([record(9, 55.1, 37.1), record(9, 55.2, 37.2)], () => null);
  assert.equal(groups[0].district, null);
});

test('ключ описания объекта собирается так же, как в импорте', () => {
  assert.equal(ppReportKey('10002198', 'Коптево'), '10002198|Коптево');
  assert.equal(ppReportKey('10002198', null), '10002198|unassigned');
});

test('голосование по району принимает готовый счётчик', () => {
  const rows = [record(1, 55.87, 37.55), record(1, 55.88, 37.56)];
  assert.equal(majorityDistrict(rows, () => 'Ховрино'), 'Ховрино');
  assert.equal(majorityDistrict([], () => 'Ховрино'), null);
});

test('пустой и неверный ввод отклоняется', () => {
  assert.throws(() => groupPpRecords(null, () => null), /records/);
  assert.throws(() => groupPpRecords([], 'нет'), /resolveDistrict/);
});
