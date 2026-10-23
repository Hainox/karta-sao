import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeDistrictPoints } from '../src/tpu-points/district-points-report.js';
import { summarizeDistrictPhotos } from '../src/tpu-points/district-photo-report.js';

const sample = [
  { district: 'Аэропорт', label: '1.1', heading: 90, review_status: 'pending', photo_count: 0 },
  { district: 'Аэропорт', label: '1.2', heading: 180, review_status: 'accepted', photo_count: 2, last_photo_at: '2026-10-22T10:00:00Z' },
  { district: 'Сокол', label: '13.1', heading: null, review_status: 'rework', review_comment: 'Уточнить направление.', photo_count: 0 },
];

test('сводка по точкам показывает статусы приёмки отдельно от фото', () => {
  const report = summarizeDistrictPoints({ points: sample });
  assert.equal(report.districtRows.length, 16);
  assert.deepEqual(report.districtRows.find((row) => row.district === 'Аэропорт'), {
    district: 'Аэропорт', points: 2, arrows: 2, pending: 1, accepted: 1, rework: 0,
  });
  assert.equal(report.total.points, 3);
  assert.equal(report.total.rework, 1);
  assert.equal(report.pointRows[2].review_comment, 'Уточнить направление.');
});

test('сводка по фото отдельно считает только фактически загруженные снимки', () => {
  const report = summarizeDistrictPhotos({ points: sample });
  const aeroport = report.districtRows.find((row) => row.district === 'Аэропорт');
  const sokol = report.districtRows.find((row) => row.district === 'Сокол');
  assert.equal(aeroport.photos, 2);
  assert.equal(aeroport.pointsWithPhotos, 1);
  assert.equal(aeroport.acceptedPoints, 1);
  assert.equal(sokol.photos, 0);
  assert.equal(report.total.photos, 2);
  assert.equal(report.total.acceptedPoints, 1);
});
