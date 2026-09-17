import assert from 'node:assert/strict';
import test from 'node:test';
import { completionMix, dayKey, summarizeByDistrict, summarizeCoverage, summarizeCoverageByType, uploadDynamics } from '../src/report.js';

function row(district, objectType, confirmed, { pending = 0, uploadedAt = [] } = {}) {
  return {
    district,
    object_type: objectType,
    confirmedPhotos: confirmed,
    pendingReviewPhotos: pending,
    photos: uploadedAt.map((stamp, index) => ({ id: `${district}-${objectType}-${index}`, uploadedAt: stamp })),
  };
}

test('aggregates approved completion and photo counters by object type', () => {
  const report = summarizeCoverage([
    { objectType: 'stop', confirmedPhotos: 1, pendingReviewPhotos: 0 },
    { objectType: 'pp', confirmedPhotos: 1, pendingReviewPhotos: 0 },
    { objectType: 'pp', confirmedPhotos: 0, pendingReviewPhotos: 2 },
    { objectType: 'entrance', confirmedPhotos: 0, pendingReviewPhotos: 0 },
  ]);

  assert.deepEqual(report, {
    totalObjects: 4,
    objectsWithPhoto: 3,
    objectsWithoutPhoto: 1,
    completedObjects: 1,
    partialObjects: 1,
    pendingReviewObjects: 1,
    totalPoints: 0,
    coveredPoints: 0,
    pointsWithoutPhoto: 0,
    completionPercent: 25,
    statusBand: 'low',
  });
});

test('counts an object with enough confirmed photos as complete while exposing its pending photo', () => {
  const report = summarizeCoverage([
    { objectType: 'pp', confirmedPhotos: 2, pendingReviewPhotos: 1 },
  ]);

  assert.equal(report.completedObjects, 1);
  assert.equal(report.pendingReviewObjects, 1);
  assert.equal(report.completionPercent, 100);
});

test('keeps pending photos out of confirmed completion', () => {
  const report = summarizeCoverage([
    { objectType: 'stop', confirmedPhotos: 0, pendingReviewPhotos: 1 },
  ]);

  assert.equal(report.objectsWithPhoto, 1);
  assert.equal(report.completedObjects, 0);
  assert.equal(report.pendingReviewObjects, 1);
  assert.equal(report.completionPercent, 0);
});

test('исходные данные с лишними полями не ломают сводку', () => {
  // Риски по GPS убраны из отчёта: поле geoRisk в выгрузке больше не считается,
  // но старые строки с ним не должны ронять сводку.
  const report = summarizeCoverage([
    { objectType: 'stop', confirmedPhotos: 1, pendingReviewPhotos: 0, geoRisk: true },
  ]);

  assert.equal(report.completedObjects, 1);
  assert.equal('geoRiskObjects' in report, false);
});

test('does not calculate a percentage for an empty scope', () => {
  assert.deepEqual(summarizeCoverage([]), {
    totalObjects: 0,
    objectsWithPhoto: 0,
    objectsWithoutPhoto: 0,
    completedObjects: 0,
    partialObjects: 0,
    pendingReviewObjects: 0,
    totalPoints: 0,
    coveredPoints: 0,
    pointsWithoutPhoto: 0,
    completionPercent: null,
    statusBand: null,
  });
});

test('считает отметки точек источника отдельно от уникальных объектов', () => {
  const report = summarizeCoverage([
    { objectType: 'pp', confirmedPhotos: 1, pendingReviewPhotos: 0, sourcePointCount: 43, coveredPoints: 2 },
    { objectType: 'stop', confirmedPhotos: 0, pendingReviewPhotos: 0, sourcePointCount: 1, coveredPoints: 0 },
    // Больше закрытых точек, чем объявлено в наборе, факт не удваивает.
    { objectType: 'pp', confirmedPhotos: 1, pendingReviewPhotos: 0, sourcePointCount: 2, coveredPoints: 5 },
  ]);

  assert.equal(report.totalObjects, 3);
  assert.equal(report.totalPoints, 46);
  assert.equal(report.coveredPoints, 4);
  assert.equal(report.pointsWithoutPhoto, 42);
});

test('без точек источника закрытых отметок нет: «5 из 0» не печатается', () => {
  // Объект объявил ноль отметок, но кадры к нему есть: закрытых отметок не
  // может быть больше плана, иначе PDF пишет «Отметки: 5 из 0 отработано».
  const report = summarizeCoverage([
    { objectType: 'pp', confirmedPhotos: 1, pendingReviewPhotos: 0, sourcePointCount: 0, coveredPoints: 5 },
  ]);

  assert.equal(report.totalPoints, 0);
  assert.equal(report.coveredPoints, 0);
  assert.equal(report.pointsWithoutPhoto, 0);
});

test('отметки сводки совпадают со штабной моделью, включая пустой план', async () => {
  const { headquartersCounts, headquartersFactTotal, headquartersPlanTotal } = await import('../src/headquarters.js');
  const records = [
    { objectType: 'stop', confirmedPhotos: 1, pendingReviewPhotos: 0, sourcePointCount: 43, coveredPoints: 9 },
    // Больше закрытых отметок, чем объявлено: обе модели обрезают факт планом.
    { objectType: 'pp', confirmedPhotos: 1, pendingReviewPhotos: 0, sourcePointCount: 2, coveredPoints: 5 },
    { objectType: 'entrance', confirmedPhotos: 0, pendingReviewPhotos: 0, sourcePointCount: 0, coveredPoints: 4 },
  ];

  const report = summarizeCoverage(records);
  const counts = headquartersCounts(records);

  // Одна единица учёта — отметка: сводка САО, лист «На штаб», картинка и PDF
  // считают план и факт одинаково, иначе артефакты расходятся в числах.
  assert.equal(report.totalPoints, headquartersPlanTotal(counts));
  assert.equal(report.coveredPoints, headquartersFactTotal(counts));
  assert.equal(report.coveredPoints, 11);
});

test('splits a scoped report into stop, pp, and entrance summaries', () => {
  const byType = summarizeCoverageByType([
    { objectType: 'stop', confirmedPhotos: 1, pendingReviewPhotos: 0 },
    { objectType: 'pp', confirmedPhotos: 2, pendingReviewPhotos: 0 },
    { objectType: 'entrance', confirmedPhotos: 0, pendingReviewPhotos: 0 },
  ]);

  assert.equal(byType.stop.completedObjects, 1);
  assert.equal(byType.pp.completionPercent, 100);
  assert.equal(byType.entrance.objectsWithoutPhoto, 1);
  assert.deepEqual(Object.keys(byType), ['stop', 'pp', 'entrance']);
});

test('rejects malformed coverage records without accepting unknown object types', () => {
  assert.throws(
    () => summarizeCoverage([{ objectType: 'unknown', confirmedPhotos: 1, pendingReviewPhotos: 0 }]),
    /objectType/,
  );
  assert.throws(
    () => summarizeCoverage([{ objectType: 'stop', confirmedPhotos: -1, pendingReviewPhotos: 0 }]),
    /confirmedPhotos/,
  );
  assert.throws(
    () => summarizeCoverage([{ objectType: 'stop', confirmedPhotos: 1.5, pendingReviewPhotos: 0 }]),
    /confirmedPhotos/,
  );
});

/* ------------------------------------------------- данные для диаграмм */

test('районный разрез сортирует по выполнению и замыкает строкой «АвД САО»', () => {
  const districts = summarizeByDistrict([
    row('Сокол', 'stop', 1),
    row('Аэропорт', 'stop', 0),
    row('Аэропорт', 'stop', 0),
    // Объект без района приписать конкретному району нельзя — он идёт в «АвД САО».
    row(null, 'pp', 0),
  ]);
  assert.deepEqual(districts.map((entry) => entry.district), ['Сокол', 'Аэропорт', 'АвД САО']);
  assert.equal(districts[0].completionPercent, 100);
  assert.equal(districts[1].totalObjects, 2);
  assert.equal(districts[1].statusBand, 'low');
  assert.equal(districts[2].totalObjects, 1);
});

test('объекты «АвД САО», «ДЭУ» и объекты без района считаются за строку «АвД САО»', () => {
  const districts = summarizeByDistrict([
    // Объект стоит в Коптеве, но балансодержатель — «АвД САО».
    { ...row('Коптево', 'stop', 0), balance_holder: 'АвД САО' },
    // Балансодержатель «ДЭУ N» — тот же владелец.
    { ...row('Сокол', 'stop', 0), balance_holder: 'ДЭУ 2' },
    // Объект без района не приписывается району, где стоит.
    row(null, 'entrance', 0),
    // Обычный районный объект остаётся за своим районом.
    row('Аэропорт', 'pp', 1),
  ]);

  const byName = Object.fromEntries(districts.map((entry) => [entry.district, entry]));
  assert.deepEqual(Object.keys(byName).sort(), ['АвД САО', 'Аэропорт']);
  assert.equal(byName['АвД САО'].totalObjects, 3);
  assert.equal(byName['Аэропорт'].totalObjects, 1);
  // В разрезе нет пустого района, а «АвД САО» всегда последняя строкой.
  assert.ok(districts.every((entry) => entry.district));
  assert.equal(districts[districts.length - 1].district, 'АвД САО');
});

test('dynamics counts uploads per MSK day and keeps a running total', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const series = uploadDynamics([
    row('Сокол', 'stop', 1, { uploadedAt: ['2026-09-14T09:00:00Z'] }),
    row('Сокол', 'stop', 1, { uploadedAt: ['2026-09-15T09:00:00Z', '2026-09-15T18:00:00Z'] }),
    row('Сокол', 'stop', 1, { uploadedAt: ['2026-08-01T09:00:00Z'] }),
  ], { days: 3, now });

  assert.equal(series.length, 3);
  assert.deepEqual(series.map((point) => point.date), ['2026-09-13', '2026-09-14', '2026-09-15']);
  assert.deepEqual(series.map((point) => point.uploaded), [0, 1, 2]);
  // Фотографии до окна входят в накопленный итог, но не в дневные столбцы.
  assert.deepEqual(series.map((point) => point.cumulative), [1, 2, 4]);
});

test('вечерняя фиксация попадает в московский день, а не в предыдущий', () => {
  // 22:30 UTC 16.09 — это 01:30 МСК 17.09: рабочий день округа уже следующий.
  const series = uploadDynamics([
    row('Сокол', 'stop', 1, { uploadedAt: ['2026-09-16T22:30:00Z'] }),
    row('Сокол', 'stop', 1, { uploadedAt: ['2026-09-16T20:00:00Z'] }),
  ], { days: 2, now: new Date('2026-09-17T06:00:00Z') });

  assert.deepEqual(series.map((point) => point.date), ['2026-09-16', '2026-09-17']);
  // 20:00 UTC — ещё 23:00 МСК 16.09, а 22:30 UTC — уже 17.09 по МСК.
  assert.deepEqual(series.map((point) => point.uploaded), [1, 1]);
});

test('ключ дня считается по заданной зоне', () => {
  assert.equal(dayKey('2026-09-16T22:30:00Z'), '2026-09-17');
  assert.equal(dayKey('2026-09-16T20:59:59Z'), '2026-09-16');
  assert.equal(dayKey('2026-09-16T22:30:00Z', 'UTC'), '2026-09-16');
  assert.equal(dayKey('не дата'), null);
});

test('dynamics survives rows without photos and broken timestamps', () => {
  const series = uploadDynamics([
    row('Сокол', 'stop', 0),
    { ...row('Сокол', 'entrance', 0), photos: [{ id: 'x', uploadedAt: 'не дата' }] },
  ], { days: 2, now: new Date('2026-09-15T00:00:00Z') });
  assert.deepEqual(series.map((point) => point.uploaded), [0, 0]);
  assert.deepEqual(series.map((point) => point.cumulative), [0, 0]);
});

test('completion mix splits states without double counting', () => {
  const mix = completionMix({ totalObjects: 10, completedObjects: 4, partialObjects: 3 });
  assert.deepEqual(mix, [
    { key: 'done', label: 'Выполнено', value: 4 },
    { key: 'partial', label: 'Частично', value: 3 },
    { key: 'empty', label: 'Без фото', value: 3 },
  ]);
  assert.equal(mix.reduce((sum, part) => sum + part.value, 0), 10);
});

test('completion mix handles an empty scope and rejects bad input', () => {
  assert.deepEqual(completionMix({ totalObjects: 0, completedObjects: 0, partialObjects: 0 }).map((part) => part.value), [0, 0, 0]);
  assert.throws(() => completionMix(null), /summary is required/);
  assert.throws(() => uploadDynamics([], { days: 0 }), /days/);
  assert.throws(() => summarizeByDistrict(null), /Report rows/);
});
