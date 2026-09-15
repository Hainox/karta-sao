import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginThrottle } from '../src/login-throttle.js';

test('successful sign-ins never lock out a shared office address', () => {
  const throttle = createLoginThrottle({ limit: 3 });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    assert.equal(throttle.allowed('office'), true);
    throttle.clear('office');
  }
  assert.equal(throttle.trackedKeys, 0);
});

test('failed sign-ins are limited inside the window', () => {
  const throttle = createLoginThrottle({ limit: 3 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(throttle.allowed('office'), true);
    throttle.recordFailure('office');
  }
  assert.equal(throttle.allowed('office'), false);
  assert.equal(throttle.allowed('another-office'), true);
});

test('a successful sign-in clears the failure counter', () => {
  const throttle = createLoginThrottle({ limit: 3 });
  throttle.recordFailure('office');
  throttle.recordFailure('office');
  assert.equal(throttle.allowed('office'), true);
  throttle.clear('office');
  assert.equal(throttle.trackedKeys, 0);
  assert.equal(throttle.allowed('office'), true);
});

test('the failure counter expires with the window', () => {
  let clock = 0;
  const throttle = createLoginThrottle({ limit: 2, windowMs: 1000, now: () => clock });
  throttle.recordFailure('office');
  throttle.recordFailure('office');
  assert.equal(throttle.allowed('office'), false);
  clock = 1001;
  assert.equal(throttle.allowed('office'), true);
  assert.equal(throttle.trackedKeys, 0);
});

test('an invalid throttle configuration is rejected instead of silently allowing', () => {
  assert.throws(() => createLoginThrottle({ limit: 0 }), /limit/);
  assert.throws(() => createLoginThrottle({ windowMs: 0 }), /windowMs/);
});
