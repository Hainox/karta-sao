import assert from 'node:assert/strict';
import test from 'node:test';
import { captureLocation, distanceMeters } from '../../districts/review-location.mjs';

test('card preserves a north-facing slot and distinguishes absent GPS from the assigned position', () => {
  const row = { latitude: 55.8, longitude: 37.5, heading: 0 };
  assert.deepEqual(captureLocation(row), { point: [55.8, 37.5], heading: 0, gps: null });
  assert.equal(captureLocation({ ...row, heading: null }).heading, null);
  assert.equal(captureLocation({ latitude: null, longitude: null }).point, null);
});

test('actual GPS is separate and distance uses both coordinates', () => {
  const location = captureLocation({ latitude: 55.8, longitude: 37.5, heading: 270, gps_latitude: 55.801, gps_longitude: 37.5 });
  assert.deepEqual(location.gps, [55.801, 37.5]);
  assert.ok(Math.abs(distanceMeters(location.point, location.gps) - 111.2) < 0.2);
});
