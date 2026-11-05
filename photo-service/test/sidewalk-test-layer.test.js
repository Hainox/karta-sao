import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSidewalkTestLayerRouter } from '../src/tpu-points/sidewalk-test-layer.js';

const point = { id: 'AVD-P01', taskId: 'AVD', district: 'Аэропорт', balance: 'АВД САО', street: 'Переулок', coordinates: [37.51, 55.81],
  sidewalkId: '10001', roadId: '20001', slots: [{ id: 'AVD-P01-F01', azimuth: 24.9, sidewalkIds: '10001' }, { id: 'AVD-P01-F02', azimuth: 204.9, sidewalkIds: '10001' }] };

test('закрытый слой отдаёт отдельные азимуты слотов только префектуре и только по выбранному району', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidewalk-test-'));
  const catalogPath = join(dir, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ version: 1, points: [point, { ...point, id: 'P02', district: 'Коптево', slots: [{ id: 'P02-F01', azimuth: 0, sidewalkIds: '10001' }] }] }));
  const app = express();
  app.use(createSidewalkTestLayerRouter({ catalogPath, authenticate: (req, res, next) => {
    const role = req.get('x-test-role');
    if (!role) return res.sendStatus(401);
    req.user = { role, district: 'Аэропорт' };
    next();
  } }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const root = 'http://127.0.0.1:' + server.address().port;
  const get = (role, district = 'Аэропорт') => fetch(root + '/?district=' + encodeURIComponent(district), { headers: role ? { 'x-test-role': role } : {} });
  try {
    assert.equal((await get()).status, 401);
    for (const role of ['district_editor', 'reviewer', 'avd_editor']) assert.equal((await get(role)).status, 403);
    assert.equal((await get('prefecture_admin', 'Другой район')).status, 400);
    const response = await get('prefecture_admin');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await response.json()).points, [point]);
    await rm(catalogPath);
    // В пределах процесса используется одна проверенная версия набора.
    assert.equal((await get('prefecture_admin')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
