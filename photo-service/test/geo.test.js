import assert from 'node:assert/strict';
import test from 'node:test';
import { assessDistanceRisk, haversineDistanceMeters } from '../src/geo.js';

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

test('marks a fix beyond the approved 15 metre radius as a risk', () => {
  const result = assessDistanceRisk(
    { latitude: 55.75, longitude: 37.61 },
    [{ latitude: 55.7503, longitude: 37.61 }],
  );

  assert.equal(result.risk, true);
  assert.equal(result.radiusMeters, 15);
  assert.equal(result.toleranceMeters, 5);
  assert.equal(result.effectiveRadiusMeters, 20);
  assert.ok(result.distanceMeters > 15);
});

test('keeps a fix in the approved five metre GPS tolerance as a visible tolerance state', () => {
  const result = assessDistanceRisk(
    { latitude: 55.75, longitude: 37.61 },
    [{ latitude: 55.75015, longitude: 37.61 }],
  );

  assert.equal(result.status, 'within_tolerance');
  assert.equal(result.risk, false);
  assert.equal(result.nominalRadiusExceeded, true);
  assert.ok(result.distanceMeters > 15 && result.distanceMeters <= 20);
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
