import assert from 'node:assert/strict';
import test from 'node:test';
import { loadReportRows, reportPayload } from '../src/reports.js';

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

test('районная сводка запрашивает возвращённые фото вместе с причиной', async () => {
  const queries = [];
  const pool = { query: async (sql) => { queries.push(sql); return { rows: [] }; } };
  await loadReportRows(pool, { role: 'district_editor', district: 'Сокол' }, undefined, { includeRejected: true });
  assert.match(queries[0], /p\.review_status <> 'withdrawn'/);
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
  assert.deepEqual(payload.unassigned.objects, []);
});

test('объекты без района перечисляются списком, а не только числом', () => {
  const payload = reportPayload([
    row('Сокол', 'stop', 1),
    { ...row(null, 'entrance', 0), object_key: 'injob_entrances|entrance|77|1|unassigned', label: 'Коптево, 5, подъезд 3', sourcePointCount: 1 },
    { ...row(null, 'pp', 0), object_key: 'odh_pp_coordinates|pp|10002198|unassigned', label: 'Бескудниковский бульвар', sourcePointCount: 4 },
  ]);

  assert.equal(payload.unassigned.totalObjects, 2);
  assert.equal(payload.unassigned.objects.length, 2);
  const [first] = payload.unassigned.objects;
  assert.equal(first.objectKey, 'injob_entrances|entrance|77|1|unassigned');
  assert.equal(first.label, 'Коптево, 5, подъезд 3');
  assert.equal(first.sourcePoints, 1);
  assert.equal(payload.unassigned.listLimit, 100);
});

test('отметки районов сходятся со сводкой САО: сумма по районам равна итогу', () => {
  // Отметки приходят из выборки: у одного перехода их десятки, и каждая закрывается сама.
  const rows = [
    { ...row('Сокол', 'stop', 1), sourcePointCount: 43, coveredPoints: 9 },
    { ...row('Аэропорт', 'pp', 1), sourcePointCount: 31, coveredPoints: 11 },
    { ...row('Коптево', 'stop', 0), sourcePointCount: 100, coveredPoints: 60 },
    // Объект без района тоже входит в сводку САО: он учтён в строке «АвД САО».
    { ...row(null, 'entrance', 0), sourcePointCount: 7, coveredPoints: 0 },
  ];
  const payload = reportPayload(rows);

  assert.equal(payload.overall.totalPoints, 181);
  assert.equal(payload.overall.coveredPoints, 80);

  // Районный разрез не теряет отметки: иначе «Отметки» в районе и в сводке
  // расходятся, и сумма по районам не сходится с итогом.
  const sum = (key) => payload.byDistrict.reduce((total, district) => total + district[key], 0);
  assert.equal(sum('totalPoints'), payload.overall.totalPoints);
  assert.equal(sum('coveredPoints'), payload.overall.coveredPoints);
  assert.equal(sum('totalObjects'), payload.overall.totalObjects);
  assert.equal(sum('objectsWithPhoto'), payload.overall.objectsWithPhoto);

  // И по каждому району отметки видны в разрезе, а не только объекты.
  const byName = Object.fromEntries(payload.byDistrict.map((district) => [district.district, district]));
  assert.equal(byName['Сокол'].totalPoints, 43);
  assert.equal(byName['Сокол'].coveredPoints, 9);
  assert.equal(byName['АвД САО'].totalPoints, 7);
  assert.equal(byName['Коптево'].coveredPoints, 60);
});
