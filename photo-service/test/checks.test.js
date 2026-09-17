import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceHolderOf, checksByDistrict, checksByObject, collectChecks, odhIdOf, summarizeChecks } from '../src/checks.js';

const object = (objectKey, photos, extra = {}) => ({
  objectKey,
  objectType: 'entrance',
  district: 'Ховрино',
  label: `Объект ${objectKey}`,
  reference_points: [{ latitude: 55.8, longitude: 37.5 }],
  properties: {},
  photos,
  ...extra,
});

const photo = (id, extra = {}) => ({
  id,
  sha256: `hash-${id}`,
  performer: 'Иванов И.И.',
  uploadedAt: '2026-09-17T08:00:00Z',
  ...extra,
});

test('дубль файла на разных объектах попадает в проверки', () => {
  // Один и тот же кадр прикрепили к двум разным объектам — это ошибка данных.
  const checks = collectChecks([
    object('a', [photo('p1', { sha256: 'shared' })]),
    object('b', [photo('p2', { sha256: 'shared' })]),
  ]);

  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map((check) => check.kind), ['duplicate_photo', 'duplicate_photo']);
  assert.equal(checks[0].kindLabel, 'Дубль фото на разных объектах');
  assert.deepEqual(checks[0].duplicateObjects.sort(), ['a', 'b']);
});

test('повторная съёмка одного объекта дублем не считается', () => {
  const checks = collectChecks([object('a', [photo('p1', { sha256: 'same' }), photo('p2', { sha256: 'same' })])]);
  assert.deepEqual(checks, []);
});

test('расстояние и точность GPS проверок больше не создают', () => {
  // Раньше здесь были «Превышение зоны» и «Недостоверная геопривязка» —
  // GPS признан необъективным показателем, поэтому обе категории убраны.
  const checks = collectChecks([
    object('a', [
      photo('p1', { distanceM: 120, gpsAccuracyM: 1586473.47, geoStatus: 'risk' }),
      photo('p2', { distanceM: 34.4, gpsAccuracyM: 2 }),
    ]),
  ]);
  assert.deepEqual(checks, []);
});

test('сводка проверок считает категории', () => {
  const checks = collectChecks([
    object('a', [photo('p1', { sha256: 'shared' })]),
    object('b', [photo('p2', { sha256: 'shared' })]),
  ]);
  const summary = summarizeChecks(checks);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.byKind, [{ kind: 'duplicate_photo', kindLabel: 'Дубль фото на разных объектах', count: 2 }]);
});

test('проверки разносятся по районам и объектам', () => {
  const checks = collectChecks([
    object('a', [photo('p1', { sha256: 'shared' })], { district: 'Ховрино' }),
    object('b', [photo('p2', { sha256: 'shared' })], { district: 'Коптево' }),
  ]);
  const byDistrict = checksByDistrict(checks);
  assert.equal(byDistrict.get('Ховрино'), 1);
  assert.equal(byDistrict.get('Коптево'), 1);
  const byObject = checksByObject(checks);
  assert.equal(byObject.get('a'), 1);
  assert.equal(byObject.get('b'), 1);
});

test('объекты владельца и без района считаются за «АвД САО»', () => {
  const checks = collectChecks([
    object('a', [photo('p1', { sha256: 'shared' })], { district: 'Коптево', properties: { Баланс: 'АвД САО' } }),
    object('b', [photo('p2', { sha256: 'shared' })], { district: null }),
  ]);
  const byDistrict = checksByDistrict(checks);
  assert.equal(byDistrict.get('АвД САО'), 2);
});

test('балансодержатель и номер ОДХ читаются из свойств объекта', () => {
  assert.equal(balanceHolderOf({ properties: { Балансодержатель: 'АвД САО' } }), 'АвД САО');
  assert.equal(balanceHolderOf({ properties: { Баланс: 'ДЭУ 2' } }), 'ДЭУ 2');
  assert.equal(balanceHolderOf({ district: 'Сокол', properties: {} }), 'Жилищник «Сокол»');
  assert.equal(balanceHolderOf({ properties: {} }), null);
  assert.equal(odhIdOf({ properties: { 'ID объекта ОДХ': 10002198 } }), '10002198');
  assert.equal(odhIdOf({ properties: {} }), null);
});

test('пустой ввод не роняет проверки', () => {
  assert.deepEqual(collectChecks([]), []);
  assert.deepEqual(collectChecks(null), []);
  assert.deepEqual(summarizeChecks(null).byKind, []);
});
