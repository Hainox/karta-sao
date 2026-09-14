import assert from 'node:assert/strict';
import test from 'node:test';
import { databasePoolOptions } from '../lib/database-config.js';

test('keeps DATABASE_URL support for ordinary deployments', () => {
  const connectionString = 'postgresql://app:secret@db:5432/odh_sao';
  assert.deepEqual(databasePoolOptions({ DATABASE_URL: connectionString }), { connectionString });
});

test('uses discrete PostgreSQL settings without building a credential URL', () => {
  assert.deepEqual(databasePoolOptions({ PGHOST: 'postgres', PGDATABASE: 'odh_sao', PGUSER: 'odh_app', PGPASSWORD: 'p@ss:/?#%' }), {});
});

test('rejects incomplete database configuration', () => {
  assert.throws(() => databasePoolOptions({ PGHOST: 'postgres' }), /DATABASE_URL или PGHOST/);
});
