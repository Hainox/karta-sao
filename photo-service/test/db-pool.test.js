import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { createDatabasePool } from '../src/db-pool.js';

test('an idle client error is logged instead of crashing the process', () => {
  const messages = [];
  const pool = createDatabasePool({ host: '127.0.0.1', port: 1 }, { log: (message) => messages.push(message) });

  assert.ok(pool instanceof Pool);
  assert.doesNotThrow(() => pool.emit('error', new Error('Connection terminated unexpectedly')));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Connection terminated unexpectedly/);
  return pool.end();
});

test('a bare pg pool would crash on the same error', () => {
  const pool = new Pool({ host: '127.0.0.1', port: 1 });
  assert.throws(() => pool.emit('error', new Error('Connection terminated unexpectedly')));
  return pool.end();
});
