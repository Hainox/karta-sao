import assert from 'node:assert/strict';
import test from 'node:test';
import { reportPayload } from '../src/reports.js';

function row(district, objectType, confirmed, pending = 0) {
  return {
    object_key: `${objectType}|${district}|1`,
    dataset_id: 'sao_stops',
    object_type: objectType,
    report_key: '1',
    source_ids: ['stop:1'],
    district,
    label: 'Объект',
    reference_points: [],
    properties: {},
    source_version: 'embedded-map-2026-09-15',
    confirmedPhotos: confirmed,
    pendingReviewPhotos: pending,
    geoRisk: false,
    photos: [],
  };
}

test('the summary payload carries the per-district board for the prefecture', () => {
  const payload = reportPayload([
    row('Сокол', 'stop', 1),
    row('Аэропорт', 'stop', 0),
    row('Аэропорт', 'pp', 0),
    row(null, 'entrance', 0),
  ]);

  assert.equal(payload.byDistrict.length, 3);
  const [first, second, third] = payload.byDistrict;
  assert.equal(first.district, 'Сокол');
  assert.equal(first.completionPercent, 100);
  assert.equal(second.district, 'Аэропорт');
  assert.equal(second.totalObjects, 2);
  // Объекты «АвД САО», «ДЭУ» и объекты без района собираются строкой
  // «АвД САО» — она замыкает доску и не смешивается с районами.
  assert.equal(third.district, 'АвД САО');
  assert.equal(third.totalObjects, 1);
});

test('the board keeps the same arithmetic as the overall summary', () => {
  // Объект без района тоже входит в сводку САО: он учтён в строке «АвД САО».
  const rows = [row('Сокол', 'stop', 1), row('Сокол', 'stop', 0), row('Аэропорт', 'stop', 0), row(null, 'stop', 0)];
  const payload = reportPayload(rows);
  assert.equal(payload.unassigned.totalObjects, 1);
  const boardTotal = payload.byDistrict.reduce((sum, district) => sum + district.totalObjects, 0);
  assert.equal(boardTotal, payload.overall.totalObjects);
  const boardCompleted = payload.byDistrict.reduce((sum, district) => sum + district.completedObjects, 0);
  assert.equal(boardCompleted, payload.overall.completedObjects);
});

test('an empty scope still returns an empty board instead of failing', () => {
  const payload = reportPayload([]);
  assert.deepEqual(payload.byDistrict, []);
  assert.equal(payload.overall.totalObjects, 0);
});
