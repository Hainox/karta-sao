import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHealthHandler } from '../src/health.js';

async function withHealthServer(probeDatabase, check) {
  const server = createServer(createHealthHandler({ probeDatabase }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    await check('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('GET /healthz reports the dedicated service and its database connection', async () => {
  await withHealthServer(async () => {}, async (baseUrl) => {
    const response = await fetch(baseUrl + '/healthz');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      service: 'sao-photo-service',
      status: 'ok',
      database: 'connected',
    });
  });
});

test('GET /healthz returns a generic unavailable response when PostgreSQL is down', async () => {
  await withHealthServer(async () => {
    throw new Error('database unavailable');
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/healthz');
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.deepEqual(body, {
      service: 'sao-photo-service',
      status: 'unavailable',
      database: 'unavailable',
    });
    assert.equal(JSON.stringify(body).includes('database unavailable'), false);
  });
});

test('legacy API health paths are not exposed by the photo service', async () => {
  await withHealthServer(async () => {}, async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/health');

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });
});

test('health check only accepts GET requests', async () => {
  await withHealthServer(async () => {}, async (baseUrl) => {
    const response = await fetch(baseUrl + '/healthz', { method: 'POST' });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });
});
