import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCoverage, summarizeCoverageByType } from '../src/report.js';

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
    geoRiskObjects: 0,
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

test('reports geo risks separately from completion', () => {
  const report = summarizeCoverage([
    { objectType: 'stop', confirmedPhotos: 1, pendingReviewPhotos: 0, geoRisk: true },
  ]);

  assert.equal(report.completedObjects, 1);
  assert.equal(report.geoRiskObjects, 1);
});

test('does not calculate a percentage for an empty scope', () => {
  assert.deepEqual(summarizeCoverage([]), {
    totalObjects: 0,
    objectsWithPhoto: 0,
    objectsWithoutPhoto: 0,
    completedObjects: 0,
    partialObjects: 0,
    pendingReviewObjects: 0,
    geoRiskObjects: 0,
    completionPercent: null,
    statusBand: null,
  });
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
