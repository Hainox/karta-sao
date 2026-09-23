import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountScope, accuracyVerdict, ACCURACY_REVIEW_METERS, assessDistanceRisk, auditPointLayer, bandNote, bandText, boundaryNote, buildCoverageIndex, buildQueue, canExport,
  countCoverageStatus, coverageCounterText, coverageFor, coverageLabel, coveragePercent, districtBoundaries, filterRecords, formatAccuracy,
  formatCoordinates, formatDateTime, formatMeters, geoStatusText, gpsDistanceLabel, haversineDistanceMeters, isAutodorHolder,
  normalizePhoto, photoDetailRows, photoRequirementFor, PHOTO_REQUIREMENTS, recordHolder, reportSummaryRows, reviewStatusText, scopedDistricts,
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

test('показывает районную причину возврата отдельной строкой', () => {
  const rows = photoDetailRows({ reviewStatus: 'rejected', reviewReason: 'Не видно разметку' });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey['Проверка'], 'На доработке');
  assert.equal(byKey['Причина доработки'], 'Не видно разметку');
});

test('formats missing values as text instead of throwing', () => {
  assert.equal(formatDateTime(null), 'время не указано');
  assert.equal(formatDateTime('not-a-date'), 'время не указано');
  assert.equal(formatMeters(undefined), '—');
  assert.equal(formatAccuracy(null), 'точность не сообщена');
  assert.equal(formatCoordinates(null, null), 'GPS отсутствует');
});

test('координаты без значения читаются текстом, а не падают и не «NaN»', () => {
  // Пустое поле строки набора раньше валило отрисовку списка и очереди:
  // undefined.toFixed бросал TypeError, а NaN печатался как «NaN, NaN».
  assert.equal(formatCoordinates(undefined, undefined), 'GPS отсутствует');
  assert.equal(formatCoordinates(null, undefined), 'GPS отсутствует');
  assert.equal(formatCoordinates(55.8, undefined), 'GPS отсутствует');
  assert.equal(formatCoordinates(NaN, 37.5), 'GPS отсутствует');
  // Координата, записанная текстом, читается числом — как и остальные поля отчёта.
  assert.equal(formatCoordinates('55.8', '37.5'), '55.800000, 37.500000');
});

test('translates review and geo statuses into explicit Russian text', () => {
  assert.equal(reviewStatusText('confirmed'), 'Подтверждено');
  assert.equal(reviewStatusText('weird'), 'Статус не указан');
  assert.equal(geoStatusText('risk'), 'Нужна ручная проверка');
  assert.equal(geoStatusText('within_tolerance'), 'В допуске 15–30 м');
  assert.equal(geoStatusText(''), 'Проверка не выполнялась');
});

test('норма фото на точку зависит от вида объекта', () => {
  assert.deepEqual(PHOTO_REQUIREMENTS, { stop: 1, pp: 2, entrance: 1 });
  assert.equal(photoRequirementFor('pp'), 2);
  assert.equal(photoRequirementFor('stop'), 1);
  assert.equal(photoRequirementFor('entrance'), 1);
  // Неизвестный вид без нормы не должен остаться: иначе точка «закрыта» сразу.
  assert.equal(photoRequirementFor(undefined), 1);
});

test('пешеходному переходу нужно два кадра на точку', () => {
  const one = buildCoverageIndex({
    objects: [{
      objectKey: 'pp|1', objectType: 'pp', district: 'Войковский', sourceIds: ['pp:1'],
      photos: [{ sourceId: 'pp:1', reviewStatus: 'confirmed' }],
    }],
  });
  const afterOne = coverageFor(one, { id: 'pp:1' }, 'pp');
  assert.equal(afterOne.required, 2);
  assert.equal(afterOne.complete, false);
  assert.equal(afterOne.remaining, 1);

  const two = buildCoverageIndex({
    objects: [{
      objectKey: 'pp|1', objectType: 'pp', district: 'Войковский', sourceIds: ['pp:1'],
      photos: [{ sourceId: 'pp:1', reviewStatus: 'confirmed' }, { sourceId: 'pp:1', reviewStatus: 'confirmed' }],
    }],
  });
  const afterTwo = coverageFor(two, { id: 'pp:1' }, 'pp');
  assert.equal(afterTwo.confirmed, 2);
  assert.equal(afterTwo.complete, true);
  assert.equal(afterTwo.remaining, 0);
});

test('точка, снятая до введения нормы двух кадров, закрыта по старому правилу', () => {
  // Кадр загружен до 12:00 МСК 18.09.2026 — тогда хватало одного.
  const legacy = buildCoverageIndex({
    objects: [{
      objectKey: 'pp|1', objectType: 'pp', district: 'Войковский', sourceIds: ['pp:1'],
      photos: [{ sourceId: 'pp:1', reviewStatus: 'pending_review', uploadedAt: '2026-09-17T10:00:00.000Z' }],
    }],
  });
  const before = coverageFor(legacy, { id: 'pp:1' }, 'pp');
  assert.equal(before.legacyClosed, true);
  assert.equal(before.complete, true);
  assert.equal(before.remaining, 0);
  // И в очередь на досъёмку такая точка не возвращается.
  assert.deepEqual(buildQueue([{ id: 'pp:1', label: 'А', group: 'Сокол' }], { coverageIndex: legacy, objectType: 'pp' }), []);

  // Кадр после порога — правило уже новое: одного мало.
  const fresh = buildCoverageIndex({
    objects: [{
      objectKey: 'pp|1', objectType: 'pp', district: 'Войковский', sourceIds: ['pp:1'],
      photos: [{ sourceId: 'pp:1', reviewStatus: 'pending_review', uploadedAt: '2026-09-18T12:30:00.000Z' }],
    }],
  });
  const after = coverageFor(fresh, { id: 'pp:1' }, 'pp');
  assert.equal(after.legacyClosed, false);
  assert.equal(after.complete, false);
  assert.equal(after.remaining, 1);
});

test('фильтр «не хватает кадра» показывает точки, которым нужен ещё кадр', () => {
  const records = [
    { id: 'pp:1', label: 'Без кадров', group: 'Сокол' },
    { id: 'pp:2', label: 'Один кадр', group: 'Сокол' },
    { id: 'pp:3', label: 'Два кадра', group: 'Сокол' },
  ];
  const photo = (sourceId, minute) => ({ sourceId, reviewStatus: 'pending_review', uploadedAt: `2026-09-19T10:${minute}:00.000Z` });
  const index = buildCoverageIndex({
    objects: [
      { objectKey: 'a', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:1'], photos: [] },
      { objectKey: 'b', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:2'], photos: [photo('pp:2', '00')] },
      { objectKey: 'c', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:3'], photos: [photo('pp:3', '00'), photo('pp:3', '05')] },
    ],
  });
  const options = { coverageIndex: index, objectType: 'pp' };
  // Нужны обе точки: где кадров нет вовсе и где есть один — раньше вторая не показывалась.
  assert.deepEqual(filterRecords(records, { ...options, status: 'incomplete' }).map((record) => record.id), ['pp:1', 'pp:2']);
  // «Без фото» по-прежнему про точки без кадров вовсе.
  assert.deepEqual(filterRecords(records, { ...options, status: 'without' }).map((record) => record.id), ['pp:1']);
});

test('снимок одной точки не подтягивается на соседние точки того же объекта', () => {
  const index = buildCoverageIndex({
    objects: [{
      objectKey: 'odh_pp_coordinates|pp|10002217|Аэропорт', objectType: 'pp', district: 'Аэропорт',
      sourceIds: ['pp:1', 'pp:2', 'pp:3'],       photos: [
        { sourceId: 'pp:1', reviewStatus: 'confirmed' },
        { sourceId: 'pp:1', reviewStatus: 'pending_review' },
      ],
    }],
  });

  const own = coverageFor(index, { id: 'pp:1' }, 'pp');
  // Норма перехода — два кадра: одного подтверждённого для закрытия мало.
  assert.equal(own.required, 2);
  assert.equal(own.confirmed, 1);
  assert.equal(own.pending, 1);
  assert.equal(own.complete, false);

  // У соседних точек того же ID снимков нет — каждая точка закрывается сама.
  for (const id of ['pp:2', 'pp:3']) {
    const neighbour = coverageFor(index, { id }, 'pp');
    assert.equal(neighbour.confirmed, 0);
    assert.equal(neighbour.pending, 0);
    assert.equal(neighbour.withPhoto, false);
    assert.equal(neighbour.statusKey, 'empty');
  }
});

test('отклонённый кадр без sourceId остаётся видимым на карте объекта', () => {
  const index = buildCoverageIndex({
    objects: [{
      objectKey: 'stop|legacy', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:a', 'stop:b'],
      photos: [{
        reviewStatus: 'rejected', reviewReason: 'missing_gps', uploadedAt: '2026-09-22T08:00:00.000Z',
      }],
    }],
  });

  for (const id of ['stop:a', 'stop:b']) {
    const coverage = coverageFor(index, { id }, 'stop');
    assert.equal(coverage.rework, 1);
    assert.equal(coverage.statusKey, 'rework');
    assert.equal(coverage.withPhoto, true);
  }
});

test('новый кадр снимает объектный fallback старого отклонения без sourceId', () => {
  const index = buildCoverageIndex({
    objects: [{
      objectKey: 'stop|legacy', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:a', 'stop:b'],
      photos: [
        { reviewStatus: 'rejected', uploadedAt: '2026-09-22T08:00:00.000Z' },
        { sourceId: 'stop:a', reviewStatus: 'pending_review', uploadedAt: '2026-09-22T09:00:00.000Z' },
      ],
    }],
  });

  assert.equal(coverageFor(index, { id: 'stop:a' }, 'stop').statusKey, 'pending');
  assert.equal(coverageFor(index, { id: 'stop:b' }, 'stop').statusKey, 'empty');
});

test('classifies a point as done, pending, or empty', () => {
  const index = buildCoverageIndex({
    objects: [
      { objectKey: 'done', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:done'], photos: [{ sourceId: 'stop:done', reviewStatus: 'confirmed' }] },
      { objectKey: 'pending', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:pending'], photos: [{ sourceId: 'stop:pending', reviewStatus: 'pending_review' }] },
      { objectKey: 'rejected', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:rejected'], photos: [{ sourceId: 'stop:rejected', reviewStatus: 'rejected' }] },
    ],
  });
  assert.equal(coverageFor(index, { id: 'stop:done' }, 'stop').statusKey, 'done');
  assert.equal(coverageFor(index, { id: 'stop:done' }, 'stop').remaining, 0);
  assert.equal(coverageFor(index, { id: 'stop:pending' }, 'stop').statusKey, 'pending');
  assert.equal(coverageFor(index, { id: 'stop:pending' }, 'stop').withPhoto, true);
  assert.equal(coverageFor(index, { id: 'stop:none' }, 'stop').statusKey, 'empty');
  assert.equal(coverageFor(index, { id: 'stop:none' }, 'stop').statusLabel, 'Без фото');
  // Возврат не закрывает точку, но объект сразу виден району как доработка.
  const rejected = coverageFor(index, { id: 'stop:rejected' }, 'stop');
  assert.equal(rejected.withPhoto, true);
  assert.equal(rejected.rework, 1);
  assert.equal(rejected.statusKey, 'rework');
  assert.equal(rejected.statusLabel, 'На доработке');
  assert.equal(rejected.remaining, 1);
});

test('точка с подтверждённым снимком всё равно показывает снимок на проверке', () => {
  const index = buildCoverageIndex({
    objects: [{
      objectKey: 'a', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:a'],
      photos: [{ sourceId: 'stop:a', reviewStatus: 'confirmed' }, { sourceId: 'stop:a', reviewStatus: 'pending_review' }],
    }],
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
    objects: [{ objectKey: 'a', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:2'], photos: [{ sourceId: 'stop:2', reviewStatus: 'confirmed' }] }],
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

test('список и легенда считают один и тот же набор точек на доработке', () => {
  const records = [
    { id: 'entrance:1', label: 'Возвращённый объект', group: 'Дмитровский' },
    { id: 'entrance:2', label: 'Объект на проверке', group: 'Дмитровский' },
    { id: 'entrance:3', label: 'Без фото', group: 'Дмитровский' },
  ];
  const coverage = buildCoverageIndex({
    objects: [
      {
        objectKey: 'entrance:returned', objectType: 'entrance', district: 'Дмитровский',
        sourceIds: ['entrance:1'],
        photos: [{ sourceId: 'entrance:1', reviewStatus: 'rejected', uploadedAt: '2026-09-22T08:00:00.000Z' }],
      },
      {
        objectKey: 'entrance:pending', objectType: 'entrance', district: 'Дмитровский',
        sourceIds: ['entrance:2'],
        photos: [{ sourceId: 'entrance:2', reviewStatus: 'pending_review', uploadedAt: '2026-09-22T08:00:00.000Z' }],
      },
    ],
  });
  const filtered = filterRecords(records, { coverageIndex: coverage, objectType: 'entrance', status: 'rework' });
  assert.deepEqual(filtered.map((record) => record.id), ['entrance:1']);
  assert.equal(countCoverageStatus(filtered, coverage, 'entrance', 'rework'), 1);
  assert.equal(countCoverageStatus(records, coverage, 'entrance', 'rework'), 1);
});

test('аудит считает без фото только рисуемые точки и отдельно находит ID вне слоя', () => {
  const records = [
    { id: 'stop:1', lat: 55.8, lon: 37.5 },
    { id: 'stop:2', lat: 55.81, lon: 37.51 },
    { id: 'stop:3', lat: null, lon: 37.52 },
  ];
  const coverage = buildCoverageIndex({
    objects: [{
      objectKey: 'mapped', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:1', 'stop:api-only'],
      photos: [{ sourceId: 'stop:1', reviewStatus: 'confirmed' }],
    }],
  });

  assert.deepEqual(auditPointLayer(records, coverage, 'stop'), {
    mapPoints: 2,
    apiPoints: 2,
    pointsWithoutPhoto: 1,
    apiOnlyIds: ['stop:api-only'],
    mapOnlyIds: ['stop:2'],
    duplicateMapIds: [],
    missingIdRecords: 0,
    invalidCoordinates: 1,
  });
});

test('фильтр по району не зависит от регистра и «ё» в названии', () => {
  const records = [{ id: 'stop:1', label: 'Коровинское шоссе', group: 'ДЭУ 2' }];
  const index = buildCoverageIndex({
    objects: [{ objectKey: 'a', objectType: 'stop', district: 'Молжаниновский', sourceIds: ['stop:1'], photos: [] }],
  });
  const options = { coverageIndex: index, objectType: 'stop' };
  assert.equal(filterRecords(records, { ...options, district: 'молжаниновский' }).length, 1);
  assert.equal(filterRecords(records, { ...options, district: ' Молжаниновский ' }).length, 1);
  assert.equal(filterRecords(records, { ...options, district: 'Коптево' }).length, 0);
});

test('the route queue skips completed objects and keeps group order', () => {
  const records = [
    { id: 'stop:1', label: 'Б', group: 'Ясенево' },
    { id: 'stop:2', label: 'А', group: 'Сокол' },
    { id: 'stop:3', label: 'В', group: 'Сокол' },
  ];
  const index = buildCoverageIndex({
    objects: [{ objectKey: 'a', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:1'], photos: [{ sourceId: 'stop:1', reviewStatus: 'confirmed' }] }],
  });
  const queue = buildQueue(records, { coverageIndex: index, objectType: 'stop' });
  assert.deepEqual(queue.map((record) => record.id), ['stop:2', 'stop:3']);
});

test('точка с загруженным, но ещё не подтверждённым кадром в очередь не возвращается', () => {
  const records = [
    { id: 'stop:1', label: 'А', group: 'Сокол' },
    { id: 'stop:2', label: 'Б', group: 'Сокол' },
    { id: 'pp:1', label: 'В', group: 'Сокол' },
  ];
  const index = buildCoverageIndex({
    objects: [
      { objectKey: 'a', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:1'], photos: [{ sourceId: 'stop:1', reviewStatus: 'pending_review' }] },
      { objectKey: 'b', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:1'], photos: [{ sourceId: 'pp:1', reviewStatus: 'pending_review' }] },
    ],
  });

  // Остановке хватит одного кадра: он есть, значит снимать нечего.
  assert.deepEqual(
    buildQueue(records.slice(0, 2), { coverageIndex: index, objectType: 'stop' }).map((record) => record.id),
    ['stop:2'],
  );
  // Переходу нужно два: с одним кадром точка остаётся в очереди.
  assert.deepEqual(
    buildQueue([records[2]], { coverageIndex: index, objectType: 'pp' }).map((record) => record.id),
    ['pp:1'],
  );

  const withTwo = buildCoverageIndex({
    objects: [{
      objectKey: 'b', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:1'],
      photos: [{ sourceId: 'pp:1', reviewStatus: 'pending_review' }, { sourceId: 'pp:1', reviewStatus: 'confirmed' }],
    }],
  });
  assert.deepEqual(buildQueue([records[2]], { coverageIndex: withTwo, objectType: 'pp' }), []);
});

test('the on-screen summary always carries a number and a band word', () => {
  const rows = reportSummaryRows({
    overall: {
      totalObjects: 100, objectsWithPhoto: 40, objectsWithoutPhoto: 60, completedObjects: 34,
      partialObjects: 6, pendingReviewObjects: 3, completionPercent: 34, statusBand: 'middle',
    },
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  // Главный показатель — охват: сколько объектов уже с фото.
  assert.equal(byKey['Охват объектов'], '40 %');
  assert.equal(byKey['Статус'], 'Жёлтый — выполнение от 33 % до 66 %');
  assert.equal(byKey['Объектов с фото'], '40');
  assert.equal(byKey['Объектов без фото'], '60');
  assert.equal(byKey['Объектов принято'], '34');
  // Рядом стоит отчётная единица: закрытые отметки, как в сводке на штаб.
  assert.equal(byKey['Закрыто отметок'], 'нет отметок');
});

test('в сводке на экране отметки считаются рядом с охватом по объектам', () => {
  const rows = reportSummaryRows({
    overall: { totalObjects: 678, objectsWithPhoto: 55, objectsWithoutPhoto: 623, totalPoints: 786, coveredPoints: 100 },
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey['Закрыто отметок'], '100 из 786 — 13 %');
  assert.equal(byKey['Охват объектов'], '8 %');
});

test('точка с одним кадром перехода — «не хватает кадра», а не «на проверке»', () => {
  const index = buildCoverageIndex({
    objects: [
      { objectKey: 'one', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:one'], photos: [{ sourceId: 'pp:one', reviewStatus: 'pending_review' }] },
      { objectKey: 'two', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:two'], photos: [{ sourceId: 'pp:two', reviewStatus: 'pending_review' }, { sourceId: 'pp:two', reviewStatus: 'pending_review' }] },
      { objectKey: 'none', objectType: 'pp', district: 'Сокол', sourceIds: ['pp:none'], photos: [] },
    ],
  });

  const one = coverageFor(index, { id: 'pp:one' }, 'pp');
  assert.equal(one.statusKey, 'incomplete');
  assert.equal(one.statusLabel, 'Не хватает кадра');
  assert.equal(one.taken, 1);
  assert.equal(one.remaining, 1);
  assert.equal(coverageCounterText(one), 'снято 1 из 2');

  // Норма набрана — это уже ожидание приёмки, а не досъёмка.
  const two = coverageFor(index, { id: 'pp:two' }, 'pp');
  assert.equal(two.statusKey, 'pending');
  assert.equal(two.remaining, 0);
  assert.equal(two.taken, 2);
  assert.equal(coverageCounterText(two), 'снято 2 из 2');

  const none = coverageFor(index, { id: 'pp:none' }, 'pp');
  assert.equal(none.statusKey, 'empty');
  assert.equal(coverageCounterText(none), 'кадров нет');

  // «Не хватает кадра» как отбор: и пустая точка, и та, где нужен второй кадр.
  const records = [{ id: 'pp:one' }, { id: 'pp:two' }, { id: 'pp:none' }];
  const options = { coverageIndex: index, objectType: 'pp' };
  assert.deepEqual(filterRecords(records, { ...options, status: 'incomplete' }).map((record) => record.id), ['pp:one', 'pp:none']);
  // «Частично» — только там, где часть кадров уже принята приёмкой.
  assert.deepEqual(filterRecords(records, { ...options, status: 'partial' }), []);
  assert.deepEqual(filterRecords(records, { ...options, status: 'done' }), []);
});

test('the summary is read from the nested overall section, not the payload root', () => {
  const payload = {
    generatedAt: '2026-09-15T00:00:00.000Z',
    sourceVersions: ['embedded-map-2026-09-15'],
    overall: { totalObjects: 10, completionPercent: 50, statusBand: 'middle' },
    unassigned: { totalObjects: 2, objectsWithoutPhoto: 2, completedObjects: 0 },
    objects: [],
  };
  assert.equal(reportSummaryRows(payload).length, 8);
  // Объекты есть, фото пока нет — это ноль процентов, а не «нет данных».
  assert.equal(coverageLabel(payload.overall), '0 %');
  assert.equal(coveragePercent(payload.overall), 0);
  assert.equal(coverageLabel({ totalObjects: 0 }), 'нет данных');
  assert.equal(coverageLabel({ totalObjects: 10, objectsWithPhoto: 5 }), '50 %');
  assert.deepEqual(reportSummaryRows({ unassigned: { totalObjects: 3 } }), []);
});

test('an empty scope is reported as having no data instead of zero percent', () => {
  const rows = reportSummaryRows({
    overall: {
      totalObjects: 0, objectsWithPhoto: 0, objectsWithoutPhoto: 0, completedObjects: 0,
      partialObjects: 0, pendingReviewObjects: 0, completionPercent: null, statusBand: null,
    },
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey['Охват объектов'], 'нет данных');
  assert.equal(byKey['Закрыто отметок'], 'нет отметок');
  assert.equal(bandText(null), 'Нет данных');
  assert.equal(bandNote(null), 'Недостаточно данных для оценки');
});

test('a non-object photo row is rejected instead of silently rendered', () => {
  assert.throws(() => normalizePhoto(null), /photo row must be an object/);
});

test('клиент импортирует из модели только те имена, что она экспортирует', async () => {
  const { readFile } = await import('node:fs/promises');
  const client = await readFile(new URL('./photo-client.js', import.meta.url), 'utf8');
  const model = await readFile(new URL('./photo-model.js', import.meta.url), 'utf8');

  const imported = client.match(/import \{([\s\S]*?)\} from '\.\/photo-model\.js'/);
  assert.ok(imported, 'клиент должен импортировать модель');
  const names = imported[1].split(',').map((name) => name.trim()).filter(Boolean);
  assert.ok(names.length > 0);

  // Отсутствующее имя ломает весь модуль: страница остаётся пустой.
  const exported = new Set(
    [...model.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)].map((match) => match[1] || match[2]),
  );
  for (const name of names) assert.ok(exported.has(name), `модель не экспортирует ${name}`);
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

test('a district split by a water mask is drawn as several parts', () => {
  const split = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { district: 'Левобережный' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[37.46, 55.85], [37.47, 55.85], [37.47, 55.86], [37.46, 55.85]]],
          [[[37.48, 55.87], [37.49, 55.87], [37.49, 55.88], [37.48, 55.87]]],
        ],
      },
    }],
  };
  const boundaries = districtBoundaries(split);
  assert.equal(boundaries.length, 2);
  assert.equal(boundaries[0].district, 'Левобережный');
  assert.deepEqual(boundaries[0].rings[0][0], [55.85, 37.46]);
  assert.deepEqual(boundaries[1].rings[0][0], [55.87, 37.48]);
});

test('a polygon with a water hole keeps its rings for the map', () => {
  const holed = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { district: 'Левобережный' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[[37.46, 55.85], [37.50, 55.85], [37.50, 55.89], [37.46, 55.85]]],
          [[[37.47, 55.86], [37.48, 55.86], [37.48, 55.87], [37.47, 55.86]]],
        ],
      },
    }],
  };
  const boundaries = districtBoundaries(holed);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].rings.length, 2);
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

test('учётка АвД видит свои объекты во всех районах, а районная — только свой', () => {
  const summary = {
    objects: [
      { objectKey: 'a', objectType: 'stop', district: 'Аэропорт' },
      { objectKey: 'b', objectType: 'pp', district: 'Коптево' },
    ],
  };
  const autodor = { role: 'district_editor', district: 'АвД САО' };
  const scope = accountScope(autodor, summary);
  assert.equal(scope.district, '');
  assert.deepEqual([...scope.objectKeys].sort(), ['a', 'b']);
  // Границы показываем все: объекты владельца стоят в разных районах.
  assert.deepEqual(scopedDistricts(autodor, '', ['Аэропорт', 'Коптево']), ['Аэропорт', 'Коптево']);

  const records = [
    { id: 'stop:1', label: 'Свой', group: 'Аэропорт', searchKey: 'свой' },
    { id: 'stop:2', label: 'Чужой', group: 'Сокол', searchKey: 'чужой' },
  ];
  const index = buildCoverageIndex({
    objects: [
      { objectKey: 'a', objectType: 'stop', district: 'Аэропорт', sourceIds: ['stop:1'], photos: [] },
      { objectKey: 'c', objectType: 'stop', district: 'Сокол', sourceIds: ['stop:2'], photos: [] },
    ],
  });
  const shown = filterRecords(records, { ...scope, coverageIndex: index, objectType: 'stop' });
  assert.deepEqual(shown.map((record) => record.id), ['stop:1']);

  // Районная учётка остаётся в своём районе.
  const airport = accountScope({ role: 'district_editor', district: 'Аэропорт' }, summary);
  assert.equal(airport.district, 'Аэропорт');
  assert.equal(airport.objectKeys, null);
  assert.deepEqual(scopedDistricts({ role: 'district_editor', district: 'Аэропорт' }, '', ['Аэропорт', 'Коптево']), ['Аэропорт']);
});

test('владелец читается из свойств набора и распознаётся как АвД или ДЭУ', () => {
  assert.equal(isAutodorHolder(recordHolder({ properties: { 'Баланс': 'АвД САО' } })), true);
  assert.equal(isAutodorHolder(recordHolder({ properties: { 'Балансодержатель': 'ДЭУ 1' } })), true);
  assert.equal(isAutodorHolder(recordHolder({ properties: { 'Балансодержатель': 'Жилищник Сокол' } })), false);
  assert.equal(isAutodorHolder(recordHolder({ properties: {} })), false);
  assert.equal(isAutodorHolder(recordHolder({})), false);
});

test('объекты АвД и ДЭУ не попадают в список района', () => {
  const records = [
    { id: 'pp:1', label: 'Свой переход', group: 'Дмитровский', properties: { 'Баланс': 'Жилищник Дмитровский' } },
    { id: 'pp:2', label: 'Переход ДЭУ', group: 'Дмитровский', properties: { 'Баланс': 'ДЭУ 2' } },
    { id: 'pp:3', label: 'Переход АвД', group: 'Дмитровский', properties: { 'Баланс': 'АвД САО' } },
    { id: 'pp:4', label: 'Свой подъезд', group: 'Дмитровский', properties: {} },
  ];
  const index = buildCoverageIndex({
    objects: records.map((record) => ({
      objectKey: record.id, objectType: 'pp', district: 'Дмитровский', sourceIds: [record.id], photos: [],
    })),
  });

  // Районная учётка: остаются только объекты района — как и в районной сводке.
  const own = filterRecords(records, { coverageIndex: index, objectType: 'pp', district: 'Дмитровский' });
  assert.deepEqual(own.map((record) => record.id), ['pp:1', 'pp:4']);

  // Префектура без фильтра района видит весь набор.
  assert.equal(filterRecords(records, { coverageIndex: index, objectType: 'pp' }).length, 4);
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
  assert.equal(risky.effectiveRadiusMeters, 30);
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
  // Далёкая точка больше не помечается риском: она уходит на ручную проверку.
  assert.match(far, /^До объекта 55,6 м — нужна ручная проверка\.$/);
  assert.equal(gpsDistanceLabel({ latitude: 55.8, longitude: 37.5 }, []), 'Расстояние до объекта не определено: нет зарегистрированных точек.');
});

test('a multi-point object is measured against its nearest registered point', () => {
  const points = [{ latitude: 55.8, longitude: 37.5 }, { latitude: 55.9, longitude: 37.6 }];
  const assessment = assessDistanceRisk({ latitude: 55.9001, longitude: 37.6 }, points);
  assert.equal(assessment.status, 'within_radius');
  assert.ok(assessment.distanceMeters < 15);
});

test('позиция, полученная по сети, не отправляется как координаты объекта', () => {
  // Браузер без спутников отдаёт одну точку на город: такую фиксацию не шлём.
  assert.equal(accuracyVerdict(1586473.47), 'unusable');
  assert.equal(accuracyVerdict(501), 'unusable');
  // Ровно 500 м — граница пригодности.
  assert.equal(accuracyVerdict(500), 'review');
  assert.equal(accuracyVerdict(12), 'review');
  assert.equal(accuracyVerdict(3), 'ok');
  // Точность не сообщена: отправлять можно, но решение о пригодности за сервисом.
  assert.equal(accuracyVerdict(null), 'unknown');
});

test('шкала точности клиента совпадает с серверной', async () => {
  const { ACCURACY_REVIEW_METERS: serverReview, accuracyFlag } = await import('../photo-service/src/geo.js');
  assert.equal(ACCURACY_REVIEW_METERS, serverReview);
  for (const meters of [null, undefined, Number.NaN, -1, 0, 4.9, 5, 5.1, 12, 500, 501, 1586473]) {
    assert.equal(accuracyVerdict(meters), accuracyFlag(meters), String(meters));
  }
});
