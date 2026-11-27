import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabasePool } from '../src/db-pool.js';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { createPhotoServicePointsAdapter } from '../src/tpu-points/photo-service-points-adapter.js';
import { dpspSessionAllowed } from '../src/tpu-points/dpsp-access.js';
import { importParks } from './import-park-digitization.js';

assert.equal(process.env.PLAYGROUND_DISPOSABLE_DB, 'yes', 'Нужна отдельная тестовая БД.');
const pool = createDatabasePool(photoServiceDatabaseConfig(process.env));
const base = '/object-photo-points/parks';
const users = {
  admin: { id: randomUUID(), role: 'prefecture_admin', district: null },
  editor: { id: randomUUID(), role: 'dpsp_district_editor', district: 'Аэропорт' },
  foreign: { id: randomUUID(), role: 'district_editor', district: 'Войковский' },
};
const shape = (lng) => ({ type: 'Polygon', coordinates: [[[lng, 55.793], [lng + 0.003, 55.793],
  [lng + 0.003, 55.795], [lng, 55.795], [lng, 55.793]]] });
const park = (district, name, geometry, registry_status) => ({
  id: randomUUID(), district, name, geometry, registry_status, asu_ids: [], source_objects: [{ row: 2 }],
  geometry_source: 'Тестовые данные', needs_review: false,
});
const a = park('Аэропорт', 'Тестовый парк', shape(37.54), 'absent_in_source');
const b = park('Войковский', 'Тестовый парк 2', shape(37.55), 'matched');
const conflicted = park('Аэропорт', 'Тестовый парк · спорный район', shape(37.56), 'conflict');
const unbounded = park('Аэропорт', 'Тестовый парк без контура', null, 'unverified');
const seed = { version: 1, parks: [a, b, conflicted, unbounded], points: [] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1kAAAAASUVORK5CYII=', 'base64');
let server;

try {
  execFileSync(process.execPath, ['scripts/migrate.js']);
  execFileSync(process.execPath, ['scripts/migrate.js']);
  for (const { id, role, district } of Object.values(users)) {
    await pool.query('INSERT INTO users (id,email,display_name,role,district,password_hash) VALUES ($1,$2,$1,$3,$4,$1)',
      [id, id + '@example.invalid', role, district]);
  }
  const boundary = JSON.parse(await readFile(new URL('../src/tpu-points/sao_boundary_wgs84.geojson', import.meta.url)));
  await importParks(pool, seed);
  assert.equal((await importParks(pool, seed)).parks, 4);
  const app = createPhotoServicePointsAdapter({
    pool, boundary, currentUser(req) {
      const user = users[req.get('X-Test-Role')];
      return user && dpspSessionAllowed(user, new URL(req.originalUrl, 'http://localhost').pathname) ? user : null;
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const call = async (path, { role = 'admin', method = 'GET', json, image = false, status = 200 } = {}) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + base + path, {
      method, headers: { 'X-Test-Role': role, 'Content-Type': image ? 'image/png' : 'application/json' },
      body: image ? png : json === undefined ? undefined : JSON.stringify(json),
    });
    const data = response.headers.get('content-type')?.startsWith('image/')
      ? Buffer.from(await response.arrayBuffer()) : await response.json();
    assert.equal(response.status, status, `${method} ${path} (${role}) ${JSON.stringify(data)}`);
    return data;
  };
  const list = (district, options) => call('/district?district=' + encodeURIComponent(district), options);
  const reviewQueue = options => call('/review/queue', options);
  const create = (overrides, options) => call('/points', { method: 'POST', status: 201, ...options,
    json: { id: randomUUID(), district: a.district, parkId: a.id, coordinates: [37.541, 55.794], azimuth: 75, ...overrides },
  });
  const coords = [37.542, 55.794];
  await list(a.district, { role: 'guest', status: 401 });
  await list(b.district, { role: 'editor', status: 403 });
  await list(a.district, { role: 'editor', status: 403 });
  await list(b.district, { role: 'foreign', status: 403 });
  await reviewQueue({ role: 'guest', status: 401 });
  await reviewQueue({ role: 'editor', status: 403 });
  assert.deepEqual(new Set((await list(a.district)).parks.map(park => park.id)), new Set([a.id, conflicted.id, unbounded.id]));
  await create({ parkId: null }, { status: 404 });
  await create({ parkId: b.id }, { status: 404 });
  await create({ parkId: unbounded.id }, { status: 422 });
  await create({ parkId: unbounded.id, locationReason: 'Тестовый внешний проход' });
  await create({}, { role: 'editor', status: 403 });
  await create({ coordinates: [37.551, 55.794] }, { status: 422 });
  const id = randomUUID();
  const one = (await create({ id })).point;
  const retry = (await create({ id })).point;
  assert.equal(retry.slot.id, one.slot.id);
  const pointPath = '/points/' + id;
  const patch = (json, options) => call(pointPath, { method: 'PATCH', json, ...options });
  const erase = (revision, status = 200) => call(pointPath, { method: 'DELETE', json: { revision }, status });
  const two = (await patch({ coordinates: coords, azimuth: 123.45, revision: one.revision })).point;
  assert.equal(two.parkId, a.id);
  assert.equal(two.slot.id, one.slot.id);
  assert.equal(two.slot.azimuth, 123.45);
  assert.deepEqual(two.coordinates, coords);
  await patch({ azimuth: 180, revision: one.revision }, { status: 409 });
  await patch({ parkId: b.id, coordinates: [37.551, 55.794], revision: two.revision }, { status: 409 });
  await patch({ coordinates: [37.551, 55.794], revision: two.revision }, { status: 422 });
  const frame = '/frames/' + two.slot.id;
  const upload = (where, role, status = 201) => call(where + '/photo', { method: 'PUT', image: true, role, status });
  await upload(frame, 'foreign', 403);
  const conflictPoint = (await create({ parkId: conflicted.id, coordinates: [37.561, 55.794] })).point;
  await upload('/frames/' + conflictPoint.slot.id, 'editor', 403);
  await upload(frame, 'editor', 403);
  const { photo } = await upload(frame, 'admin');
  await upload(frame, 'admin', 409);
  const firstPhoto = frame + '/photos/' + photo.id;
  assert.deepEqual(await call(firstPhoto), png);
  await call(firstPhoto, { role: 'foreign', status: 403 });
  await call(firstPhoto + '/review', { method: 'POST', json: { decision: 'rejected', comment: 'Переснять' } });
  const second = (await upload(frame, 'admin')).photo;
  const three = (await patch({ coordinates: [37.551, 55.794], parkId: b.id, revision: two.revision, confirmReassignment: true })).point;
  assert.equal(three.slot.id, two.slot.id);
  assert.equal(three.slot.photoId, second.id);
  assert.equal(three.parkId, b.id);
  const newPhoto = frame + '/photos/' + second.id;
  await call(newPhoto, { role: 'editor', status: 403 });
  assert.deepEqual(await call(newPhoto), png);
  assert.equal((await list(b.district)).points[0].id, id);
  assert.equal((await list(a.district)).points.some(point => point.id === id), false);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM park_digitization_photos WHERE frame_id = $1', [one.slot.id])).rows[0].count, 2);
  await call(newPhoto + '/review', { method: 'POST', json: { decision: 'accepted' } });
  await erase(three.revision, 409);
  assert.equal((await list(b.district)).points.find(point => point.id === id).slot.status, 'accepted');
  assert.deepEqual(await call(newPhoto), png);
  const initialQueue = await reviewQueue();
  assert.equal(initialQueue.parks.find(item => item.id === a.id).registry_status, 'absent_in_source');
  assert.deepEqual(initialQueue.counts, { total: 3, pending: 0, rework: 0, accepted: 1, empty: 2 });
  const [accepted] = initialQueue.accepted;
  assert.equal(accepted.source_point_id, id);
  assert.equal(accepted.point_id, three.slot.id);
  assert.equal(accepted.park_id, b.id);
  assert.equal(accepted.label, b.name);
  assert.equal(accepted.district, b.district);
  assert.equal(accepted.photo_id, second.id);
  assert.ok(accepted.reviewed_at);

  for (const state of ['pending', 'rejected']) {
    const point = (await create({})).point;
    const pendingFrame = '/frames/' + point.slot.id;
    const { photo: pending } = await upload(pendingFrame, 'admin');
    const photoPath = pendingFrame + '/photos/' + pending.id;
    if (state === 'rejected') await call(photoPath + '/review', { method: 'POST', json: { decision: state, comment: 'Переснять' } });
    const queue = await reviewQueue();
    const [row] = queue[state === 'rejected' ? 'rework' : 'pending'];
    assert.equal(row.park_id, a.id);
    assert.equal(row.source_point_id, point.id);
    assert.equal(row.photo_id, pending.id);
    assert.equal(row.rejected_comment, state === 'rejected' ? 'Переснять' : null);
    const remove = { method: 'DELETE', json: { revision: point.revision } };
    await call('/points/' + point.id, { ...remove, role: 'editor', status: 403 });
    await call('/points/' + point.id, remove);
    assert.deepEqual((await reviewQueue()).counts, initialQueue.counts);
    assert.ok(!(await list(a.district)).points.some(item => item.id === point.id));
    await call(photoPath, { status: 404 });
    const { rows: [stored] } = await pool.query('SELECT status, photo_bytes FROM park_digitization_photos WHERE id = $1', [pending.id]);
    assert.deepEqual(stored, { status: state, photo_bytes: png });
  }

  const laterLink = { ...seed, parks: [{ ...a, asu_ids: ['1'], registry_status: 'matched' }] };
  await importParks(pool, laterLink, { objectsOnly: true, updateRegistry: true });
  assert.deepEqual((await list(a.district)).parks.find(park => park.id === a.id).asu_ids, ['1']);

  const empty = (await create({})).point;
  await call('/points/' + empty.id, { method: 'DELETE', json: { revision: empty.revision } });
  await upload('/frames/' + empty.slot.id, 'admin', 404);
  assert.equal((await list(a.district)).points.some(point => point.id === empty.id), false);

  const racing = (await create({})).point;
  const raw = 'http://127.0.0.1:' + server.address().port + base;
  const [uploadResult, deleteResult] = await Promise.all([
    fetch(raw + '/frames/' + racing.slot.id + '/photo', {
      method: 'PUT', headers: { 'X-Test-Role': 'admin', 'Content-Type': 'image/png' }, body: png,
    }),
    fetch(raw + '/points/' + racing.id, {
      method: 'DELETE', headers: { 'X-Test-Role': 'admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: racing.revision }),
    }),
  ]);
  assert.equal(deleteResult.status, 200);
  assert.ok([201, 404].includes(uploadResult.status));
  const { rows: [record] } = await pool.query(`SELECT p.retired_at, EXISTS (
    SELECT FROM park_digitization_photos f WHERE f.frame_id = p.frame_id) AS has_photo
    FROM park_digitization_points p WHERE p.id = $1`, [racing.id]);
  assert.ok(record.retired_at);
  assert.equal(record.has_photo, uploadResult.status === 201);

  const accepting = (await create({})).point;
  const acceptingFrame = '/frames/' + accepting.slot.id;
  const { photo: pending } = await upload(acceptingFrame, 'admin');
  const headers = { 'X-Test-Role': 'admin', 'Content-Type': 'application/json' };
  const [reviewResult, retireResult] = await Promise.all([
    fetch(raw + acceptingFrame + '/photos/' + pending.id + '/review', {
      method: 'POST', headers, body: JSON.stringify({ decision: 'accepted' }),
    }),
    fetch(raw + '/points/' + accepting.id, {
      method: 'DELETE', headers, body: JSON.stringify({ revision: accepting.revision }),
    }),
  ]);
  assert.ok([[200, 409], [404, 200]].some(([review, retire]) =>
    review === reviewResult.status && retire === retireResult.status));
  console.log('PASS: PostgreSQL · миграции, районы, привязка, один фотослот, правки, фотографии, гонка загрузки и удаления');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
}
