import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSidewalkList, sidewalkRetirePlan } from '../scripts/retire-sidewalk-points.js';

test('parseSidewalkList reads point numbers and skips comments and repeats', () => {
  assert.deepEqual(parseSidewalkList('# Лишние точки 15.1\nТ15.208\nТ15.208\n  Т15.2001  \nмусор\n'), ['Т15.208', 'Т15.2001']);
});

test('sidewalkRetirePlan keeps points with photos and points changed after the export', () => {
  const since = new Date('2026-11-02T00:00:00+03:00');
  const old = '2026-10-30T10:00:00Z';
  const rows = [
    { point_no: 'Т15.1', retired_at: null, updated_at: old, created_at: old, live_photos: 0 },
    { point_no: 'Т15.2', retired_at: null, updated_at: old, created_at: old, live_photos: 1 },
    { point_no: 'Т15.3', retired_at: null, updated_at: '2026-11-02T12:00:00Z', created_at: old, live_photos: 0 },
    { point_no: 'Т15.4', retired_at: old, updated_at: old, created_at: old, live_photos: 0 },
  ];
  const plan = sidewalkRetirePlan(['Т15.1', 'Т15.2', 'Т15.3', 'Т15.4', 'Т15.5'], rows, since);
  assert.deepEqual(plan.retire.map((row) => row.point_no), ['Т15.1']);
  assert.deepEqual(plan.withPhoto, ['Т15.2']);
  assert.deepEqual(plan.changedLater, ['Т15.3']);
  assert.deepEqual(plan.already, ['Т15.4']);
  assert.deepEqual(plan.missing, ['Т15.5']);
});
