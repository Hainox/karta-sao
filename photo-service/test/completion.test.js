import assert from 'node:assert/strict';
import test from 'node:test';
import { PHOTO_REQUIREMENTS, completionProgress } from '../src/completion.js';

test('uses the approved confirmed-photo requirements by object type', () => {
  assert.deepEqual(PHOTO_REQUIREMENTS, {
    stop: 1,
    pp: 2,
    entrance: 1,
  });
});

test('keeps values below 33 percent in the low band', () => {
  assert.deepEqual(completionProgress(32, 100), {
    completedObjects: 32,
    totalObjects: 100,
    completionPercent: 32,
    band: 'low',
  });
});

test('starts the middle band at exactly 33 percent', () => {
  assert.equal(completionProgress(33, 100).band, 'middle');
});

test('keeps values below 66 percent in the middle band', () => {
  assert.equal(completionProgress(65, 100).band, 'middle');
});

test('starts the high band at exactly 66 percent', () => {
  assert.equal(completionProgress(66, 100).band, 'high');
});

test('does not calculate a percentage or band for an empty scope', () => {
  assert.deepEqual(completionProgress(0, 0), {
    completedObjects: 0,
    totalObjects: 0,
    completionPercent: null,
    band: null,
  });
});

test('rejects invalid or inconsistent object counts', () => {
  assert.throws(() => completionProgress(-1, 10), /non-negative safe integers/);
  assert.throws(() => completionProgress(1.5, 10), /non-negative safe integers/);
  assert.throws(() => completionProgress(11, 10), /cannot exceed/);
});
