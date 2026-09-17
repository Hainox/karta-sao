import assert from 'node:assert/strict';
import test from 'node:test';
import { assessDistanceRisk, accuracyFlag, haversineDistanceMeters, isUnusableAccuracy, photoGeoVerdict } from '../src/geo.js';

test('calculates a zero distance for identical coordinates', () => {
  assert.equal(haversineDistanceMeters(
    { latitude: 55.75, longitude: 37.61 },
    { latitude: 55.75, longitude: 37.61 },
  ), 0);
});

test('uses the nearest registered point for a multi-point object', () => {
  const result = assessDistanceRisk(
    { latitude: 55.75, longitude: 37.61 },
    [
      { latitude: 55.751, longitude: 37.61 },
      { latitude: 55.75001, longitude: 37.61 },
    ],
  );

  assert.equal(result.referencePointIndex, 1);
  assert.equal(result.risk, false);
  assert.equal(result.approximation, 'nearest_registered_point');
  assert.ok(result.distanceMeters > 0);
});

test('фиксация дальше 30 метров от объекта считается риском', () => {
  const result = assessDistanceRisk(
    { latitude: 55.75, longitude: 37.61 },
    [{ latitude: 55.7503, longitude: 37.61 }],
  );

  assert.equal(result.risk, true);
  assert.equal(result.radiusMeters, 15);
  assert.equal(result.toleranceMeters, 15);
  assert.equal(result.effectiveRadiusMeters, 30);
  assert.ok(result.distanceMeters > 30);
});

test('фиксация внутри разброса ±15 м остаётся в допуске, а не в риске', () => {
  const result = assessDistanceRisk(
    { latitude: 55.75, longitude: 37.61 },
    [{ latitude: 55.75015, longitude: 37.61 }],
  );

  assert.equal(result.status, 'within_tolerance');
  assert.equal(result.risk, false);
  assert.equal(result.nominalRadiusExceeded, true);
  assert.ok(result.distanceMeters > 15 && result.distanceMeters <= 30);
});

test('returns manual review when GPS or registered points are missing', () => {
  assert.deepEqual(assessDistanceRisk(null, [{ latitude: 55.75, longitude: 37.61 }]), {
    status: 'review',
    reason: 'missing_gps',
  });
  assert.deepEqual(assessDistanceRisk({ latitude: 55.75, longitude: 37.61 }, []), {
    status: 'review',
    reason: 'missing_reference_points',
  });
});

test('rejects invalid coordinates and a non-positive radius', () => {
  assert.throws(
    () => haversineDistanceMeters({ latitude: 100, longitude: 37 }, { latitude: 55, longitude: 37 }),
    /latitude/,
  );
  assert.throws(
    () => assessDistanceRisk({ latitude: 55, longitude: 37 }, [{ latitude: 55, longitude: 37 }], 0),
    /radiusMeters/,
  );
  assert.throws(
    () => assessDistanceRisk({ latitude: 55, longitude: 37 }, [{ latitude: 55, longitude: 37 }], 15, -1),
    /toleranceMeters/,
  );
});

test('позиция, определённая по сети, признаётся непригодной', () => {
  // Браузер без спутников отдаёт точку по IP: такую фиксацию принимать нельзя.
  assert.equal(isUnusableAccuracy(1586473.47), true);
  assert.equal(isUnusableAccuracy(501), true);
  // Ровно 500 м — ещё граница пригодности, а не отказ.
  assert.equal(isUnusableAccuracy(500), false);
  assert.equal(isUnusableAccuracy(12), false);
  // Отсутствие точности — не отказ: фиксация уйдёт на ручную проверку.
  assert.equal(isUnusableAccuracy(null), false);
  assert.equal(isUnusableAccuracy(undefined), false);
  assert.equal(isUnusableAccuracy(Number.NaN), false);
});

test('признак точности повторяет шкалу клиента', () => {
  assert.equal(accuracyFlag(3), 'ok');
  assert.equal(accuracyFlag(5), 'ok');
  assert.equal(accuracyFlag(5.1), 'review');
  assert.equal(accuracyFlag(120), 'review');
  assert.equal(accuracyFlag(501), 'unusable');
  assert.equal(accuracyFlag(null), 'unknown');
  assert.equal(accuracyFlag(undefined), 'unknown');
  assert.equal(accuracyFlag(-1), 'unknown');
});

test('превышение зоны больше не помечается риском: только ручная проверка', () => {
  const distance = assessDistanceRisk(
    { latitude: 55.75, longitude: 37.61 },
    [{ latitude: 55.7503, longitude: 37.61 }],
  );
  const verdict = photoGeoVerdict(distance, 40);

  // GPS признан необъективным показателем: далёкая точка уходит на ручную проверку,
  // а не красится «риском», и неточность прибора тоже не делает её риском.
  assert.equal(verdict.status, 'review');
  assert.equal(verdict.reviewReason, 'far_from_registered_point');
  assert.equal(verdict.accuracy, 'review');
  assert.ok(verdict.distanceMeters > 30);
  assert.equal('risk' in verdict, false);
});

test('неточность сама по себе помечается отдельным признаком', () => {
  const inside = assessDistanceRisk(
    { latitude: 55.75, longitude: 37.61 },
    [{ latitude: 55.75, longitude: 37.61 }],
  );
  const fine = photoGeoVerdict(inside, 2);
  assert.equal(fine.status, 'within_radius');
  assert.equal(fine.reviewReason, null);
  assert.equal(fine.accuracy, 'ok');

  const coarse = photoGeoVerdict(inside, 25);
  assert.equal(coarse.status, 'within_radius');
  assert.equal(coarse.reviewReason, 'gps_accuracy_above_5m');

  const unknown = photoGeoVerdict(inside, null);
  assert.equal(unknown.status, 'within_radius');
  assert.equal(unknown.reviewReason, 'gps_accuracy_missing');
});

test('отсутствие GPS и точек сохраняет свою причину', () => {
  assert.equal(photoGeoVerdict(assessDistanceRisk(null, [{ latitude: 55.75, longitude: 37.61 }]), 3).reviewReason, 'missing_gps');
  assert.equal(photoGeoVerdict(assessDistanceRisk({ latitude: 55.75, longitude: 37.61 }, []), 3).reviewReason, 'missing_reference_points');
});

test('вердикт без результата замера не выдумывается', () => {
  assert.throws(() => photoGeoVerdict(null, 5), /distanceAssessment/);
});
