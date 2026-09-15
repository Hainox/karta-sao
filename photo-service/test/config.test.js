import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { photoServiceDatabaseConfig } from '../src/config.js';

function validEnvironment() {
  return {
    PHOTO_SERVICE_DB_HOST: 'database',
    PHOTO_SERVICE_DB_PORT: '5432',
    PHOTO_SERVICE_DB_NAME: 'sao_photo_service',
    PHOTO_SERVICE_DB_USER: 'sao_photo_service',
    PHOTO_SERVICE_DB_PASSWORD: randomBytes(24).toString('hex'),
  };
}

test('requires explicitly namespaced photo-service database settings', () => {
  assert.throws(
    () => photoServiceDatabaseConfig({ DATABASE_URL: 'postgresql://legacy.invalid/db' }),
    /PHOTO_SERVICE_DB_HOST/,
  );
});

test('builds a connection config only from photo-service settings', () => {
  const environment = validEnvironment();
  const config = photoServiceDatabaseConfig(environment);

  assert.equal(config.host, 'database');
  assert.equal(config.port, 5432);
  assert.equal(config.database, 'sao_photo_service');
  assert.equal(config.user, 'sao_photo_service');
  assert.equal(config.password, environment.PHOTO_SERVICE_DB_PASSWORD);
  assert.equal(config.connectionTimeoutMillis, 2500);
});

test('rejects an invalid PostgreSQL port without exposing environment values', () => {
  const environment = validEnvironment();
  environment.PHOTO_SERVICE_DB_PORT = 'not-a-port';

  assert.throws(
    () => photoServiceDatabaseConfig(environment),
    (error) => {
      assert.match(error.message, /PHOTO_SERVICE_DB_PORT/);
      assert.equal(error.message.includes('not-a-port'), false);
      return true;
    },
  );
});
