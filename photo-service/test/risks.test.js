import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceHolderOf, collectRisks, odhIdOf, summarizeRisks, ZONE_LIMIT_METERS } from '../src/risks.js';

// Каждому фото по умолчанию достаётся свой отпечаток: совпадение должно
// задаваться явно, иначе модуль справедливо сочтёт снимки дублями.
let photoSequence = 0;
function photo(overrides = {}) {
  photoSequence += 1;
  return {
    id: `photo-${photoSequence}`,
    sha256: `hash-${photoSequence}`,
    performer: 'Керимов Р.Ш.',
    uploadedAt: '2026-09-15T12:00:00.000Z',
    geoStatus: 'within_radius',
    reviewStatus: 'pending_review',
    gpsLatitude: 55.79,
    gpsLongitude: 37.51,
    gpsAccuracyM: 3,
    distanceM: 8,
    ...overrides,
  };
}

function object(overrides = {}) {
  return {
    objectKey: 'injob_entrances|entrance|1|1|Ховрино',
    objectType: 'entrance',
    district: 'Ховрино',
    label: 'Зеленоградская улица, дом 25, корпус 1 · подъезд 1',
    properties: {},
    reference_points: [{ latitude: 55.79, longitude: 37.51 }],
    photos: [],
    ...overrides,
  };
}

test('балансодержатель берётся из свойств объекта по известным именам', () => {
  assert.equal(balanceHolderOf(object({ properties: { Балансодержатель: 'Жилищник Западное Дегунино' } })), 'Жилищник Западное Дегунино');
  assert.equal(balanceHolderOf(object({ properties: { Баланс: 'ДЭУ 1' } })), 'ДЭУ 1');
  // Готовое значение из выборки отчёта важнее свойств.
  assert.equal(balanceHolderOf(object({ balanceHolder: 'ДЭУ 3', properties: { Баланс: 'ДЭУ 1' } })), 'ДЭУ 3');
  // У подъездов своего балансодержателя нет — подставляется район.
  assert.equal(balanceHolderOf(object({ district: 'Аэропорт', properties: {} })), 'Жилищник «Аэропорт»');
  assert.equal(balanceHolderOf(object({ district: null, properties: {} })), null);
});

test('идентификатор объекта ОДХ читается из свойств под обоими именами', () => {
  assert.equal(odhIdOf(object({ properties: { 'ID объекта ОДХ': 10002217 } })), '10002217');
  assert.equal(odhIdOf(object({ properties: { odh_id: '10002198' } })), '10002198');
  assert.equal(odhIdOf(object({ properties: {} })), null);
});

test('превышение зоны считается по расстоянию, а не по статусу', () => {
  // Статус здесь «в допуске», но датчик стоит дальше порога: нарушение есть.
  const risky = object({ photos: [photo({ id: 'p-risk', geoStatus: 'review', distanceM: ZONE_LIMIT_METERS + 14.4 })] });
  const fine = object({ objectKey: 'other', photos: [photo({ id: 'p-ok', geoStatus: 'review', distanceM: 17 })] });

  const risks = collectRisks([risky, fine]);

  assert.equal(risks.length, 1);
  assert.equal(risks[0].kind, 'zone_overflow');
  assert.equal(risks[0].kindLabel, 'Превышение зоны');
  assert.equal(risks[0].overMeters, 14.4);
  assert.equal(risks[0].statusLabel, 'Риск');
  assert.deepEqual(risks[0].photoIds, ['p-risk']);
  assert.equal(risks[0].balanceHolder, 'Жилищник «Ховрино»');
});

test('недостоверная точность GPS — отдельная категория, а не превышение зоны', () => {
  // Позиция по IP: одна точка на город и точность в сотни километров.
  const byIp = object({ photos: [photo({ id: 'p-ip', gpsAccuracyM: 1586473.47, distanceM: 5000 })] });
  const silent = object({ objectKey: 'object-2', photos: [photo({ id: 'p-silent', gpsAccuracyM: null, distanceM: 30 })] });

  const risks = collectRisks([byIp, silent]);

  assert.equal(risks.length, 2);
  assert.ok(risks.every((risk) => risk.kind === 'unreliable_geo'));
  assert.equal(risks[0].kindLabel, 'Недостоверная геопривязка');
  // Расстояние здесь ничего не доказывает, поэтому превышение не считается.
  assert.equal(risks[0].overMeters, null);
});

test('граница достоверности проходит по 100 метрам', () => {
  // Ровно 100 м — позиция ещё пригодна, и нарушение определяется расстоянием.
  const atLimit = object({ photos: [photo({ id: 'p-limit', gpsAccuracyM: 100, distanceM: 5000 })] });
  assert.equal(collectRisks([atLimit])[0].kind, 'zone_overflow');

  const above = object({ objectKey: 'object-2', photos: [photo({ id: 'p-above', gpsAccuracyM: 101, distanceM: 5000 })] });
  assert.equal(collectRisks([above])[0].kind, 'unreliable_geo');

  const fine = object({ objectKey: 'object-3', photos: [photo({ id: 'p-fine', gpsAccuracyM: 99, distanceM: 5 })] });
  assert.deepEqual(collectRisks([fine]), []);
});

test('точный дубль файла на разных объектах — риск, на одном объекте — нет', () => {
  const first = object({ objectKey: 'object-1', photos: [photo({ id: 'p1', sha256: 'b'.repeat(64) })] });
  const second = object({ objectKey: 'object-2', photos: [photo({ id: 'p2', sha256: 'b'.repeat(64) })] });
  const repeatOnSameObject = object({
    objectKey: 'object-3',
    photos: [photo({ id: 'p3', sha256: 'c'.repeat(64) }), photo({ id: 'p4', sha256: 'c'.repeat(64) })],
  });

  const risks = collectRisks([first, second, repeatOnSameObject]);

  assert.equal(risks.length, 2);
  assert.ok(risks.every((risk) => risk.kind === 'duplicate_photo'));
  assert.deepEqual(risks[0].duplicateObjects.sort(), ['object-1', 'object-2']);
  // Оба снимка пары видны в записи: префектуре нужно разбирать именно пару.
  assert.deepEqual(risks[0].photoIds.sort(), ['p1', 'p2']);
});

test('обычные фиксации рисков не создают', () => {
  const clean = object({ photos: [photo({ id: 'p-clean' })] });
  assert.deepEqual(collectRisks([clean]), []);
});

test('риски сортируются от свежих к старым, сводка считает категории', () => {
  const old = object({
    objectKey: 'object-old',
    photos: [photo({ id: 'p-old', distanceM: 120, uploadedAt: '2026-09-14T08:00:00.000Z' })],
  });
  const fresh = object({
    objectKey: 'object-fresh',
    photos: [photo({ id: 'p-new', distanceM: 120, uploadedAt: '2026-09-15T18:00:00.000Z' })],
  });

  const risks = collectRisks([old, fresh]);
  assert.deepEqual(risks.map((risk) => risk.photoIds[0]), ['p-new', 'p-old']);

  const summary = summarizeRisks(risks);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.byKind, [{ kind: 'zone_overflow', kindLabel: 'Превышение зоны', count: 2 }]);
});
