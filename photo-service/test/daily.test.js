import assert from 'node:assert/strict';
import test from 'node:test';
import { dailyComment, dailyReport, dailyWindow } from '../src/daily.js';

function objectRow(district, { objectKey = `${district}|stop|1`, photos = [], confirmed = 0, covered = 1 } = {}) {
  return {
    object_key: objectKey,
    dataset_id: 'sao_stops',
    object_type: 'stop',
    report_key: '1',
    source_ids: ['stop:1'],
    district,
    label: `${district}, 1`,
    reference_points: [],
    properties: {},
    source_version: 'embedded-map-2026-09-15',
    sourcePointCount: 1,
    coveredPoints: covered,
    confirmedPhotos: confirmed,
    pendingReviewPhotos: 0,
    unboundPhotos: 0,
    geoRisk: photos.some((photo) => photo.geoStatus === 'risk'),
    photos,
  };
}

const photo = (uploadedAt, { reviewedAt = null, reviewStatus = 'pending_review', geoStatus = 'within_radius', performer = 'Иванов И.', sourceId = 'stop:1' } = {}) => ({
  id: `p-${uploadedAt}-${performer}`,
  uploadedAt,
  reviewedAt,
  reviewStatus,
  geoStatus,
  performer,
  sourceId,
});

const NOW = new Date('2026-09-17T12:00:00Z');

test('московский день начинается в 21:00 UTC предыдущих суток', () => {
  const window = dailyWindow(NOW);
  assert.equal(window.date, '2026-09-17');
  assert.equal(window.start.toISOString(), '2026-09-16T21:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-09-17T21:00:00.000Z');
});

test('вечерняя фиксация уходит в следующий московский день', () => {
  const rows = [
    objectRow('Сокол', { photos: [photo('2026-09-16T20:00:00Z'), photo('2026-09-16T22:30:00Z')] }),
  ];
  const report = dailyReport(rows, { now: NOW, days: 5 });
  assert.equal(report.date, '2026-09-17');
  // 20:00 UTC — это 23:00 МСК 16.09 (вчера), 22:30 UTC — 01:30 МСК 17.09 (сегодня).
  assert.equal(report.overall.uploaded, 1);
  assert.equal(report.districts[0].uploaded, 1);
});

test('подтверждение считается по дате проверки, а не по дате загрузки', () => {
  const rows = [
    objectRow('Сокол', {
      confirmed: 1,
      photos: [photo('2026-09-10T09:00:00Z', { reviewStatus: 'confirmed', reviewedAt: '2026-09-17T08:00:00Z' })],
    }),
  ];
  const report = dailyReport(rows, { now: NOW, days: 5 });
  assert.equal(report.overall.closed, 1);
  assert.equal(report.overall.uploaded, 0);
  assert.equal(report.districts[0].closedPoints, 1);
});

test('отметки считаются по точкам, а не по числу кадров', () => {
  const rows = [
    objectRow('Сокол', {
      objectKey: 'sao_stops|stop|1',
      photos: [
        photo('2026-09-17T06:00:00Z', { reviewStatus: 'confirmed', reviewedAt: '2026-09-17T07:00:00Z', sourceId: 'stop:1' }),
        photo('2026-09-17T06:05:00Z', { reviewStatus: 'confirmed', reviewedAt: '2026-09-17T07:00:00Z', sourceId: 'stop:1' }),
        photo('2026-09-17T06:10:00Z', { reviewStatus: 'confirmed', reviewedAt: '2026-09-17T07:00:00Z', sourceId: 'stop:2' }),
      ],
    }),
  ];
  const report = dailyReport(rows, { now: NOW, days: 5 });
  assert.equal(report.overall.closed, 3);
  assert.equal(report.districts[0].closedPoints, 2);
});

test('проверка и исполнители попадают в дневной срез', () => {
  const rows = [
    objectRow('Сокол', {
      photos: [
        photo('2026-09-17T06:00:00Z', { geoStatus: 'risk', performer: 'Иванов И.' }),
        photo('2026-09-17T06:10:00Z', { performer: 'Иванов И.' }),
        photo('2026-09-17T06:20:00Z', { performer: 'Петров П.' }),
      ],
    }),
    objectRow('Коптево', { photos: [photo('2026-09-17T07:00:00Z', { performer: 'Сидоров С.' })] }),
  ];
  const report = dailyReport(rows, { now: NOW, days: 5 });
  assert.equal(report.overall.uploaded, 4);
  assert.equal(report.overall.pending, 4);
  assert.equal(report.overall.activeDistricts, 2);
  assert.equal(report.overall.activePerformers, 3);
  assert.equal(report.performers[0].performer, 'Иванов И.');
  assert.equal(report.performers[0].uploaded, 2);
});

test('лучшие и худшие районы разводятся по подтверждённым отметкам', () => {
  const closed = (count) => Array.from({ length: count }, (unused, index) => photo('2026-09-17T06:00:00Z', {
    reviewStatus: 'confirmed', reviewedAt: '2026-09-17T07:00:00Z', sourceId: `stop:${index}`,
  }));
  const rows = [
    objectRow('Сокол', { objectKey: 'a', photos: closed(3), confirmed: 3 }),
    objectRow('Коптево', { objectKey: 'b', photos: closed(1), confirmed: 1 }),
    objectRow('Ховрино', { objectKey: 'c' }),
  ];
  const report = dailyReport(rows, { now: NOW, days: 5 });
  assert.deepEqual(report.leaders.best.map((entry) => entry.district), ['Сокол', 'Коптево']);
  assert.ok(report.leaders.silent.includes('Ховрино'));
  // Ховрино без загрузок попадает в слабый день вместе с районами без работы.
  assert.ok(report.leaders.worst.some((entry) => entry.district === 'Ховрино'));
});

test('динамика считает дни и сравнивает с вчера и средней неделей', () => {
  const rows = [
    objectRow('Сокол', {
      photos: [
        photo('2026-09-16T06:00:00Z'), photo('2026-09-16T07:00:00Z'),
        photo('2026-09-17T06:00:00Z'), photo('2026-09-17T07:00:00Z'), photo('2026-09-17T08:00:00Z'),
      ],
    }),
  ];
  const report = dailyReport(rows, { now: NOW, days: 5 });
  assert.equal(report.dynamics.length, 5);
  assert.equal(report.dynamics.at(-1).date, '2026-09-17');
  assert.equal(report.dynamics.at(-1).uploaded, 3);
  assert.equal(report.dynamics.at(-2).uploaded, 2);
  assert.equal(report.dynamics.at(-1).cumulative, 5);
  assert.equal(report.deltas.uploadedVsYesterday, 1);
  assert.ok(report.deltas.weekAverageUploaded > 0);
});

test('пустой день не падает и не выдумывает числа', () => {
  const report = dailyReport([], { now: NOW, days: 4 });
  assert.equal(report.overall.uploaded, 0);
  assert.equal(report.overall.closed, 0);
  assert.equal(report.districts.length, 0);
  assert.deepEqual(report.leaders.best, []);
  assert.equal(report.dynamics.length, 4);
});

test('неверные входные данные отклоняются', () => {
  assert.throws(() => dailyReport(null), /rows/);
  assert.throws(() => dailyReport([], { days: 1 }), /days/);
  assert.throws(() => dailyWindow('не дата'), /valid date/);
});

test('комментарий начинается с фиксированной строки и называет лидеров', () => {
  const rows = [objectRow('Сокол', { photos: [photo('2026-09-17T06:00:00Z', { reviewStatus: 'confirmed', reviewedAt: '2026-09-17T07:00:00Z' })] })];
  const report = dailyReport(rows, { now: NOW, days: 5 });
  const lines = dailyComment(report, { generatedAt: new Date('2026-09-17T18:00:00Z') });
  assert.match(lines[0], /^Направление — «Единый отчёт по продуктивности округа за день» — /);
  assert.match(lines[0], /\(МСК\)$/);
  assert.ok(lines.some((line) => line.includes('Лучшие за день')));
  assert.ok(lines.some((line) => line.includes('загружено')));
});
