import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessDistanceRisk, bandNote, bandText, boundaryNote, buildCoverageIndex, buildQueue, canExport,
  completionLabel, coverageFor, districtBoundaries, filterRecords, formatAccuracy, formatCoordinates,
  formatDateTime, formatMeters, geoStatusText, gpsDistanceLabel, haversineDistanceMeters, normalizePhoto,
  photoDetailRows, photoRequirement, reportSummaryRows, reviewStatusText, scopedDistricts,
} from './photo-model.js';

const serverRow = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  storage_key: 'ab/abcdef.jpg',
  original_filename: 'IMG_0042.JPG',
  mime_type: 'image/jpeg',
  byte_size: 12345,
  performer: 'Иванов И.',
  comment: 'Подъезд 1',
  captured_at: '2026-09-15T10:20:30.000Z',
  uploaded_at: '2026-09-15T10:21:00.000Z',
  gps_latitude: 55.8123456,
  gps_longitude: 37.5123456,
  gps_accuracy_m: 4,
  distance_m: 12.4,
  geo_status: 'within_radius',
  review_status: 'pending_review',
  is_reference: false,
};

test('reads the snake_case shape returned by GET /photos', () => {
  const photo = normalizePhoto(serverRow);
  assert.equal(photo.capturedAt, '2026-09-15T10:20:30.000Z');
  assert.equal(photo.gpsAccuracyM, 4);
  assert.equal(photo.distanceM, 12.4);
  assert.equal(photo.geoStatus, 'within_radius');
  assert.equal(photo.reviewStatus, 'pending_review');
  assert.equal(photo.originalFilename, 'IMG_0042.JPG');
});

test('reads the camelCase shape returned by /reports/summary', () => {
  const photo = normalizePhoto({
    id: 'b', capturedAt: '2026-09-15T10:20:30.000Z', gpsAccuracyM: 3, distanceM: 4.5,
    geoStatus: 'within_tolerance', reviewStatus: 'confirmed', isReference: true, originalFilename: 'a.png',
  });
  assert.equal(photo.gpsAccuracyM, 3);
  assert.equal(photo.distanceM, 4.5);
  assert.equal(photo.geoStatus, 'within_tolerance');
  assert.equal(photo.isReference, true);
  assert.equal(photo.originalFilename, 'a.png');
});

test('never renders an invalid date or a lost GPS accuracy', () => {
  const rows = photoDetailRows(serverRow);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.notEqual(byKey['Снято'], 'Invalid Date');
  assert.match(byKey['Снято'], /2026/);
  assert.equal(byKey['Исполнитель'], 'Иванов И.');
  assert.equal(byKey['Проверка'], 'На проверке');
  assert.equal(byKey['Точность GPS'], 'точность около 4 м');
  assert.equal(byKey['Геопроверка'], 'В радиусе 15 м');
  assert.equal(byKey['Дистанция до точки'], '12,4 м');
  assert.equal(byKey['Комментарий'], 'Подъезд 1');
  assert.equal(byKey['Эталонное фото'], 'Нет');
});

test('formats missing values as text instead of throwing', () => {
  assert.equal(formatDateTime(null), 'время не указано');
  assert.equal(formatDateTime('not-a-date'), 'время не указано');
  assert.equal(formatMeters(undefined), '—');
  assert.equal(formatAccuracy(null), 'точность не сообщена');
  assert.equal(formatCoordinates(null, null), 'GPS отсутствует');
});

test('translates review and geo statuses into explicit Russian text', () => {
  assert.equal(reviewStatusText('confirmed'), 'Подтверждено');
  assert.equal(reviewStatusText('weird'), 'Статус не указан');
  assert.equal(geoStatusText('risk'), 'Риск: дальше 20 м');
  assert.equal(geoStatusText('within_tolerance'), 'В допуске 15–20 м');
  assert.equal(geoStatusText(''), 'Проверка не выполнялась');
});

test('uses the approved 1 / 2 / 1 photo requirements', () => {
  assert.equal(photoRequirement('stop'), 1);
  assert.equal(photoRequirement('pp'), 2);
  assert.equal(photoRequirement('entrance'), 1);
  assert.throws(() => photoRequirement('unknown'), /unknown object type/);
});

test('one reportable object covers every coordinate row of a multi-point PP', () => {
  const index = buildCoverageIndex({
    objects: [{
      objectKey: 'odh_pp_coordinates|pp|10002217|Аэропорт', objectType: 'pp', district: 'Аэропорт',
      sourceIds: ['pp:1', 'pp:2', 'pp:3'], confirmedPhotos: 1, pendingReviewPhotos: 1, geoRisk: true,
    }],
  });
  for (const id of ['pp:1', 'pp:2', 'pp:3']) {
    const coverage = coverageFor(index, { id }, 'pp');
    assert.equal(coverage.required, 2);
    assert.equal(coverage.confirmed, 1);
    assert.equal(coverage.pending, 1);
    assert.equal(coverage.complete, false);
    assert.equal(coverage.statusKey, 'partial');
    assert.equal(coverage.geoRisk, true);
  }
});

test('classifies an object as done, partial, pending, or empty', () => {
  const index = buildCoverageIndex({
    objects: [
      { objectKey: 'done', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:done'], confirmedPhotos: 1, pendingReviewPhotos: 0 },
      { objectKey: 'partial', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:partial'], confirmedPhotos: 1, pendingReviewPhotos: 0 },
      { objectKey: 'pending', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:pending'], confirmedPhotos: 0, pendingReviewPhotos: 1 },
    ],
  });
  assert.equal(coverageFor(index, { id: 'stop:done' }, 'stop').statusKey, 'done');
  assert.equal(coverageFor(index, { id: 'stop:done' }, 'stop').remaining, 0);
  assert.equal(coverageFor(index, { id: 'pp:partial' }, 'pp').statusKey, 'partial');
  assert.equal(coverageFor(index, { id: 'pp:partial' }, 'pp').remaining, 1);
  assert.equal(coverageFor(index, { id: 'stop:pending' }, 'stop').statusKey, 'pending');
  assert.equal(coverageFor(index, { id: 'stop:pending' }, 'stop').withPhoto, true);
  assert.equal(coverageFor(index, { id: 'stop:none' }, 'stop').statusKey, 'empty');
  assert.equal(coverageFor(index, { id: 'stop:none' }, 'stop').statusLabel, 'Без фото');
});

test('a completed object still reports its separate pending counter', () => {
  const index = buildCoverageIndex({
    objects: [{ objectKey: 'a', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:a'], confirmedPhotos: 2, pendingReviewPhotos: 1 }],
  });
  const coverage = coverageFor(index, { id: 'stop:a' }, 'stop');
  assert.equal(coverage.statusKey, 'done');
  assert.equal(coverage.pending, 1);
});

test('filters by district, group, free text and photo status', () => {
  const records = [
    { id: 'stop:1', label: 'Весенняя улица', group: 'Дегунино', searchKey: 'весенняя улица дегунино' },
    { id: 'stop:2', label: 'Сокол, 5', group: 'Сокол', searchKey: 'сокол 5' },
  ];
  const index = buildCoverageIndex({
    objects: [{ objectKey: 'a', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:2'], confirmedPhotos: 1, pendingReviewPhotos: 0 }],
  });
  const options = { coverageIndex: index, objectType: 'stop' };
  assert.equal(filterRecords(records, { ...options, status: 'with' }).length, 1);
  assert.equal(filterRecords(records, { ...options, status: 'without' }).length, 1);
  assert.equal(filterRecords(records, { ...options, status: 'done' })[0].id, 'stop:2');
  assert.equal(filterRecords(records, { ...options, district: 'Сокол' })[0].id, 'stop:2');
  assert.equal(filterRecords(records, { ...options, group: 'Дегунино' })[0].id, 'stop:1');
  assert.equal(filterRecords(records, { ...options, query: 'сокол' })[0].id, 'stop:2');
  assert.equal(filterRecords(records, { ...options, status: 'pending' }).length, 0);
});

test('the route queue skips completed objects and keeps group order', () => {
  const records = [
    { id: 'stop:1', label: 'Б', group: 'Ясенево' },
    { id: 'stop:2', label: 'А', group: 'Сокол' },
    { id: 'stop:3', label: 'В', group: 'Сокол' },
  ];
  const index = buildCoverageIndex({
    objects: [{ objectKey: 'a', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:1'], confirmedPhotos: 1, pendingReviewPhotos: 0 }],
  });
  const queue = buildQueue(records, { coverageIndex: index, objectType: 'stop' });
  assert.deepEqual(queue.map((record) => record.id), ['stop:2', 'stop:3']);
});

test('the on-screen summary always carries a number and a band word', () => {
  const rows = reportSummaryRows({
    overall: {
      totalObjects: 100, objectsWithPhoto: 40, objectsWithoutPhoto: 60, completedObjects: 34,
      partialObjects: 6, pendingReviewObjects: 3, geoRiskObjects: 2, completionPercent: 34, statusBand: 'middle',
    },
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey['Выполнение'], '34,0 %');
  assert.equal(byKey['Статус'], 'Жёлтый — выполнение от 33 % до 66 %');
  assert.equal(byKey['Частично заполнено'], '6');
  assert.equal(byKey['Риск геопревышения'], '2');
});

test('the summary is read from the nested overall section, not the payload root', () => {
  const payload = {
    generatedAt: '2026-09-15T00:00:00.000Z',
    sourceVersions: ['embedded-map-2026-09-15'],
    overall: { totalObjects: 10, completionPercent: 50, statusBand: 'middle' },
    unassigned: { totalObjects: 2, objectsWithoutPhoto: 2, completedObjects: 0 },
    objects: [],
  };
  assert.equal(reportSummaryRows(payload).length, 9);
  assert.equal(completionLabel(payload), '50,0 %');
  assert.equal(completionLabel({ overall: { completionPercent: null } }), 'нет данных');
  assert.equal(completionLabel({}), 'нет данных');
  assert.deepEqual(reportSummaryRows({ unassigned: { totalObjects: 3 } }), []);
});

test('an empty scope is reported as having no data instead of zero percent', () => {
  const rows = reportSummaryRows({
    overall: {
      totalObjects: 0, objectsWithPhoto: 0, objectsWithoutPhoto: 0, completedObjects: 0,
      partialObjects: 0, pendingReviewObjects: 0, geoRiskObjects: 0, completionPercent: null, statusBand: null,
    },
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey['Выполнение'], 'нет данных');
  assert.equal(bandText(null), 'Нет данных');
  assert.equal(bandNote(null), 'Недостаточно данных для оценки');
});

test('a non-object photo row is rejected instead of silently rendered', () => {
  assert.throws(() => normalizePhoto(null), /photo row must be an object/);
});

const GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { district: 'Аэропорт' },
      geometry: { type: 'Polygon', coordinates: [[[37.5, 55.8], [37.6, 55.8], [37.6, 55.9], [37.5, 55.8]]] },
    },
    {
      type: 'Feature',
      properties: { district: 'Сокол' },
      geometry: { type: 'Polygon', coordinates: [[[37.4, 55.7], [37.45, 55.7], [37.45, 55.75], [37.4, 55.7]]] },
    },
    { type: 'Feature', properties: { district: 'Без геометрии' }, geometry: null },
  ],
};

test('district boundaries swap GeoJSON lon/lat into map lat/lon pairs', () => {
  const boundaries = districtBoundaries(GEOJSON);
  assert.equal(boundaries.length, 2);
  assert.equal(boundaries[0].district, 'Аэропорт');
  assert.deepEqual(boundaries[0].rings[0][0], [55.8, 37.5]);
  assert.equal(boundaries[0].rings.length, 1);
});

test('a district account gets only its own boundary', () => {
  const boundaries = districtBoundaries(GEOJSON, ['Аэропорт']);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].district, 'Аэропорт');
});

test('a missing geojson does not break the map', () => {
  assert.deepEqual(districtBoundaries(null), []);
  assert.deepEqual(districtBoundaries({}), []);
  assert.deepEqual(districtBoundaries({ features: [] }), []);
});

test('the boundary note names what is on screen', () => {
  assert.equal(boundaryNote(['Аэропорт'], 16), 'Показана граница района: Аэропорт.');
  assert.equal(boundaryNote(['Аэропорт', 'Сокол'], 16), 'Показаны границы районов: Аэропорт, Сокол.');
  assert.equal(boundaryNote(['A', 'B'], 2), 'Показаны границы всех 2 районов.');
  assert.equal(boundaryNote([], 16), 'Границы районов не показаны.');
});

test('a district account is scoped to its own district and cannot export', () => {
  const districtUser = { role: 'district_editor', district: 'Сокол' };
  const prefectureUser = { role: 'prefecture_admin', district: null };
  assert.deepEqual(scopedDistricts(districtUser, '', ['Сокол', 'Аэропорт']), ['Сокол']);
  assert.deepEqual(scopedDistricts(districtUser, 'Аэропорт', ['Сокол', 'Аэропорт']), ['Сокол']);
  // A district account stays on its own district even when the boundary file is missing.
  assert.deepEqual(scopedDistricts(districtUser, '', []), ['Сокол']);
  assert.deepEqual(scopedDistricts({ role: 'district_editor', district: null }, '', ['Сокол']), []);
  assert.deepEqual(scopedDistricts(prefectureUser, '', ['Сокол', 'Аэропорт']), ['Сокол', 'Аэропорт']);
  assert.deepEqual(scopedDistricts(prefectureUser, 'Аэропорт', ['Сокол', 'Аэропорт']), ['Аэропорт']);
  assert.deepEqual(scopedDistricts(null, '', ['Сокол']), ['Сокол']);

  assert.equal(canExport(districtUser), false);
  assert.equal(canExport(prefectureUser), true);
  assert.equal(canExport(null), false);
});

/* --------------------------------------------------------------- geo check */

test('the distance uses the same haversine as the service', () => {
  const metres = haversineDistanceMeters({ latitude: 55.8, longitude: 37.5 }, { latitude: 55.8009, longitude: 37.5 });
  assert.ok(Math.abs(metres - 100) < 1, `expected about 100 m, got ${metres}`);
  assert.equal(haversineDistanceMeters({ latitude: 55.8, longitude: 37.5 }, { latitude: 55.8, longitude: 37.5 }), 0);
});

test('the client verdict matches the service verdict for the same fix', async () => {
  const { assessDistanceRisk: serverAssess } = await import('../photo-service/src/geo.js');
  const points = [{ latitude: 55.8, longitude: 37.5 }, { latitude: 55.801, longitude: 37.501 }];
  const fixes = [
    { latitude: 55.8, longitude: 37.5 },
    { latitude: 55.80008, longitude: 37.5 },
    { latitude: 55.80014, longitude: 37.5 },
    { latitude: 55.8005, longitude: 37.5 },
  ];
  for (const fix of fixes) {
    const mine = assessDistanceRisk(fix, points);
    const theirs = serverAssess(fix, points);
    assert.equal(mine.status, theirs.status, JSON.stringify(fix));
    assert.ok(Math.abs(mine.distanceMeters - theirs.distanceMeters) < 0.001, JSON.stringify(fix));
  }
});

test('a fix is classified inside the radius, inside the tolerance, or as a risk', () => {
  const point = [{ latitude: 55.8, longitude: 37.5 }];
  const near = assessDistanceRisk({ latitude: 55.80009, longitude: 37.5 }, point);
  assert.equal(near.status, 'within_radius');
  assert.equal(near.risk, false);
  const tolerated = assessDistanceRisk({ latitude: 55.80014, longitude: 37.5 }, point);
  assert.equal(tolerated.status, 'within_tolerance');
  assert.equal(tolerated.risk, false);
  const risky = assessDistanceRisk({ latitude: 55.8005, longitude: 37.5 }, point);
  assert.equal(risky.status, 'risk');
  assert.equal(risky.risk, true);
  assert.equal(risky.effectiveRadiusMeters, 20);
});

test('a missing fix or missing points falls back to manual review', () => {
  assert.equal(assessDistanceRisk(null, [{ latitude: 55.8, longitude: 37.5 }]).status, 'review');
  assert.equal(assessDistanceRisk({ latitude: 55.8, longitude: 37.5 }, []).status, 'review');
  assert.equal(assessDistanceRisk({ latitude: 55.8, longitude: 37.5 }, [{ latitude: 'x', longitude: null }]).status, 'review');
});

test('the GPS note states the distance and the verdict in words', () => {
  const point = [{ latitude: 55.8, longitude: 37.5 }];
  const close = gpsDistanceLabel({ latitude: 55.80009, longitude: 37.5 }, point);
  assert.match(close, /^До объекта 10(,0)? м — в радиусе 15 м\.$/);
  const far = gpsDistanceLabel({ latitude: 55.8005, longitude: 37.5 }, point);
  assert.match(far, /^До объекта 55,6 м — риск: дальше 20 м\.$/);
  assert.equal(gpsDistanceLabel({ latitude: 55.8, longitude: 37.5 }, []), 'Расстояние до объекта не определено: нет зарегистрированных точек.');
});

test('a multi-point object is measured against its nearest registered point', () => {
  const points = [{ latitude: 55.8, longitude: 37.5 }, { latitude: 55.9, longitude: 37.6 }];
  const assessment = assessDistanceRisk({ latitude: 55.9001, longitude: 37.6 }, points);
  assert.equal(assessment.status, 'within_radius');
  assert.ok(assessment.distanceMeters < 15);
});
