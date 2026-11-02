import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createObjectPositionsRouter, validateObjectPosition, withObjectPositions } from '../src/tpu-points/object-positions.js';

// Простая база в памяти: понимает три запроса маршрутов переноса и журнал.
function fakePool() {
  const rows = new Map();
  const audit = [];
  return {
    rows, audit,
    async query(sql, params = []) {
      if (sql.startsWith('SELECT')) return { rows: [...rows.values()] };
      if (sql.startsWith('INSERT INTO tpu_object_positions')) {
        const row = { object_key: params[0], longitude: params[1], latitude: params[2], updated_at: new Date() };
        rows.set(params[0], row);
        return { rows: [row] };
      }
      if (sql.startsWith('DELETE')) { rows.delete(params[0]); return { rows: [] }; }
      if (sql.startsWith('INSERT INTO audit_log')) { audit.push(params[1]); return { rows: [] }; }
      throw new Error('unexpected ' + sql);
    },
  };
}

async function serve(role, pool, run) {
  const app = express();
  app.use(express.json());
  const authenticate = (req, res, next) => (role ? (req.user = { role, sub: 'u1' }, next()) : res.status(401).json({ error: 'Войдите' }));
  app.use('/positions', createObjectPositionsRouter({ pool, authenticate, boundary: null }));
  const server = app.listen(0);
  try { await run('http://127.0.0.1:' + server.address().port + '/positions'); } finally { server.close(); }
}
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('префектура переносит объект, место видно всем, сброс возвращает исходное', async () => {
  const pool = fakePool();
  await serve('prefecture_admin', pool, async (base) => {
    const moved = await put(base + '/tpu:800905601', { longitude: 37.481, latitude: 55.8785 });
    assert.equal(moved.status, 200);
    assert.deepEqual((await moved.json()).position.longitude, 37.481);
    assert.equal((await put(base + '/tpu:nope', { longitude: 37.4, latitude: 55.8 })).status, 404);
    assert.equal((await put(base + '/tpu:800905601', { longitude: 'x' })).status, 422);
    assert.deepEqual(pool.audit, ['tpu_object_moved']);
    assert.equal((await fetch(base + '/tpu:800905601', { method: 'DELETE' })).status, 204);
    assert.equal(pool.rows.size, 0);
  });
  pool.rows.set('tpu:800905601', { object_key: 'tpu:800905601', longitude: 37.5, latitude: 55.8 });
  await serve(null, pool, async (base) => {
    const list = await (await fetch(base)).json();
    assert.deepEqual(list.positions.map((p) => p.object_key), ['tpu:800905601'], 'список мест открыт без входа');
    assert.equal((await put(base + '/tpu:800905601', { longitude: 37.4, latitude: 55.8 })).status, 401);
  });
  for (const role of ['district_editor', 'reviewer']) {
    await serve(role, pool, async (base) => {
      assert.equal((await put(base + '/tpu:800905601', { longitude: 37.4, latitude: 55.8 })).status, 403);
    });
  }
});

test('координаты проверяются, архив берёт перенесённое место и помнит исходное', () => {
  assert.ok(validateObjectPosition({ longitude: '37.5', latitude: '55.8' }).value);
  assert.ok(validateObjectPosition({ longitude: null, latitude: 55.8 }).error);
  const objects = new Map([['p', { id: 'p', lat: 55.1, lon: 37.1 }], ['q', { id: 'q', lat: 55.2, lon: 37.2 }]]);
  const moved = withObjectPositions(objects, new Map([['p', { lat: 55.9, lon: 37.9 }], ['gone', { lat: 1, lon: 1 }]]));
  assert.deepEqual([moved.get('p').lat, moved.get('p').lon, moved.get('p').sourceLat], [55.9, 37.9, 55.1]);
  assert.equal(moved.get('q').lat, 55.2);
  assert.equal(moved.has('gone'), false);
  assert.equal(objects.get('p').lat, 55.1, 'исходный каталог не меняется');
});
