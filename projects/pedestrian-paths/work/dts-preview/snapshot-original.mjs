import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { DISTRICTS } from '../../../../photo-service/src/tpu-points/validation.js';

// Штатный районный вход. Читаем только перечень точек без файлов и превью.
const api = 'https://obhod-sao.ru/photo-api';
const output = process.argv[2];
assert.ok(output, 'Укажите новый файл снимка.');
const startedAt = new Date().toISOString();
const points = [];
for (const district of DISTRICTS) {
  const login = await fetch(api + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: district }), signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  assert.ok(login.ok, district + ': вход ' + login.status);
  const { user, token } = await login.json();
  assert.ok(token && user.role === 'district_editor' && user.district === district);
  const headers = { Authorization: 'Bearer ' + token };
  try {
    const response = await fetch(api + '/object-photo-points/yard-paths/district', {
      headers, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, district + ': перечень ' + response.status);
    const data = await response.json();
    assert.ok(Array.isArray(data.points) && data.points.length > 0);
    for (const p of data.points) {
      assert.equal(p.district, district);
      const keys = ['id', 'district', 'balance', 'street', 'taskId', 'coordinates', 'sourceId',
        'sourcePiece', 'routeId', 'networkId', 'rule', 'review', 'noSidewalk'];
      const point = Object.fromEntries(keys.filter(k => k in p).map(k => [k, p[k]]));
      point.slots = p.slots.map(({ id, azimuth, status, photoId }) => ({ id, azimuth, status, photoId }));
      points.push(point);
    }
  } finally {
    const logout = await fetch(api + '/auth/logout', {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    assert.ok(logout.ok, district + ': выход ' + logout.status);
  }
}
points.sort((a, b) => a.id.localeCompare(b.id, 'en'));
const slots = points.flatMap(p => p.slots);
assert.equal(new Set(points.map(p => p.id)).size, points.length);
assert.equal(new Set(slots.map(s => s.id)).size, slots.length);
assert.ok(slots.every(s => typeof s.id === 'string' && Number.isFinite(s.azimuth) && s.azimuth >= 0
  && s.azimuth < 360 && ['pending', 'accepted', 'empty', 'rework'].includes(s.status)
  && (s.status === 'empty' ? s.photoId === null : typeof s.photoId === 'string')));
await writeFile(output, JSON.stringify({ version: 1, startedAt, finishedAt: new Date().toISOString(), points }),
  { flag: 'wx', encoding: 'utf8' });
console.log(JSON.stringify({ points: points.length, slots: slots.length, withPhoto: slots.filter(s => s.photoId).length }));
