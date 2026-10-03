import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import test from 'node:test';
import request from 'supertest';
import { signToken, verifyToken } from '../lib/auth.js';
import { createObjectPhotoPointRepository, createObjectPhotoPointsRouter, validateObjectPhotoPoint } from '../lib/object-photo-points.js';

const secret = 'object-photo-points-test-secret-longer-than-32';
const boundary = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[37,55],[38,55],[38,56],[37,56],[37,55]]] } }] };
const assignment = { datasetId: 'sao_tpu_parking', objectKey: 'tpu:123', objectType: 'tpu', district: 'Аэропорт', longitude: 37.5, latitude: 55.5, heading: 45, label: 'Вход со стороны улицы', note: 'Снять общий вид' };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const auth = (role, district = null) => `Bearer ${signToken({ id: crypto.randomUUID(), role, district }, secret)}`;

function fixture() {
  const points = []; const photos = [];
  const repository = {
    async listObjectPhotoPoints({ district, objectKey }) { return points.filter((p) => !p.retired_at && (!district || p.district === district) && (!objectKey || p.object_key === objectKey)); },
    async getObjectPhotoPoint({ id, district }) { return points.find((p) => p.id === id && !p.retired_at && (!district || p.district === district)) || null; },
    async createObjectPhotoPoint(input) { const p = { id: crypto.randomUUID(), dataset_id: input.datasetId, object_key: input.objectKey, object_type: input.objectType, district: input.district, longitude: input.longitude, latitude: input.latitude, label: input.label, note: input.note, heading: input.heading }; points.push(p); return p; },
    async updateObjectPhotoPoint(input) { const p = points.find((p) => p.id === input.id && !p.retired_at); if (!p) return null; for (const key of ['longitude', 'latitude', 'label', 'note', 'heading']) p[key] = input[key]; return p; },
    async retireObjectPhotoPoint({ id }) { const p = points.find((p) => p.id === id && !p.retired_at); if (!p) return null; p.retired_at = new Date().toISOString(); return p; },
    async listObjectPhotoPointPhotos(pointId) { return photos.filter((p) => p.point_id === pointId).map(({ photo_bytes, ...p }) => p); },
    async addObjectPhotoPointPhoto(input) { if (!await this.getObjectPhotoPoint({ id: input.pointId, district: input.district })) return null; const p = { id: crypto.randomUUID(), point_id: input.pointId, photo_bytes: input.bytes, photo_mime_type: input.mimeType, photo_filename: input.filename }; photos.push(p); const { photo_bytes, ...metadata } = p; return metadata; },
    async getObjectPhotoPointPhoto({ pointId, photoId }) { return photos.find((p) => p.point_id === pointId && p.id === photoId) || null; }
  };
  const app = express();
  app.use(express.json());
  const authenticate = (req, res, next) => { try { req.user = verifyToken(req.get('authorization')?.replace(/^Bearer\s+/i, ''), secret); next(); } catch (_) { res.sendStatus(401); } };
  app.use('/api/object-photo-points', createObjectPhotoPointsRouter({ repository, boundary, authenticate }));
  return { api: request(app), points, photos };
}

test('existing auth roles restrict assignment to prefecture and district lists to own district', async () => {
  const { api } = fixture();
  const root = auth('prefecture_admin'); const editor = auth('district_editor', 'Аэропорт');
  await api.get('/api/object-photo-points').expect(401);
  await api.post('/api/object-photo-points').set('Authorization', editor).send(assignment).expect(403);
  await api.post('/api/object-photo-points').set('Authorization', auth('reviewer')).send(assignment).expect(403);
  const first = await api.post('/api/object-photo-points').set('Authorization', root).send(assignment).expect(201);
  await api.post('/api/object-photo-points').set('Authorization', root).send({ ...assignment, district: 'Сокол', objectKey: 'tpu:456' }).expect(201);
  const own = await api.get('/api/object-photo-points?district=Сокол').set('Authorization', editor).expect(200);
  assert.equal(own.body.points.length, 1);
  assert.equal(own.body.points[0].id, first.body.point.id);
  await api.get('/api/object-photo-points').set('Authorization', auth('district_editor')).expect(403);
  assert.equal((await api.get('/api/object-photo-points').set('Authorization', auth('reviewer'))).body.points.length, 2);
});

test('multiple stable assignments support movement, own-district photos and exact point binding', async () => {
  const { api, photos } = fixture(); const root = auth('prefecture_admin'); const editor = auth('district_editor', 'Аэропорт'); const other = auth('district_editor', 'Сокол');
  const first = (await api.post('/api/object-photo-points').set('Authorization', root).send(assignment).expect(201)).body.point;
  const second = (await api.post('/api/object-photo-points').set('Authorization', root).send({ ...assignment, label: 'Второй вход' }).expect(201)).body.point;
  const moved = await api.patch(`/api/object-photo-points/${first.id}`).set('Authorization', root).send({ longitude: 37.6, label: 'Обновлённая точка' }).expect(200);
  assert.equal(moved.body.point.id, first.id);
  assert.equal(moved.body.point.longitude, 37.6);
  await api.patch(`/api/object-photo-points/${first.id}`).set('Authorization', editor).send({ label: 'Район' }).expect(403);
  await api.patch(`/api/object-photo-points/${first.id}`).set('Authorization', root).send({ district: 'Сокол' }).expect(400);
  await api.put(`/api/object-photo-points/${first.id}/photos`).set('Authorization', other).set('Content-Type', 'image/jpeg').set('X-Assignment-Version', '1').send(jpeg).expect(404);
  await api.put(`/api/object-photo-points/${first.id}/photos`).set('Authorization', auth('reviewer')).set('Content-Type', 'image/jpeg').set('X-Assignment-Version', '1').send(jpeg).expect(403);
  const uploaded = (await api.put(`/api/object-photo-points/${first.id}/photos`).set('Authorization', editor).set('Content-Type', 'image/jpeg').set('X-Assignment-Version', '1').set('X-Photo-Filename', 'entrance.jpg').send(jpeg).expect(201)).body.photo;
  assert.equal(uploaded.point_id, first.id);
  assert.equal(uploaded.photo_bytes, undefined);
  const list = await api.get(`/api/object-photo-points/${first.id}/photos`).set('Authorization', editor).expect(200);
  assert.equal(list.body.photos.length, 1);
  await api.get(`/api/object-photo-points/${first.id}/photos`).set('Authorization', other).expect(404);
  const download = await api.get(`/api/object-photo-points/${first.id}/photos/${uploaded.id}`).set('Authorization', editor).expect(200);
  assert.deepEqual(download.body, jpeg);
  await api.get(`/api/object-photo-points/${second.id}/photos/${uploaded.id}`).set('Authorization', editor).expect(404);
  await api.get(`/api/object-photo-points/${first.id}/photos/${uploaded.id}`).set('Authorization', other).expect(404);
  await api.delete(`/api/object-photo-points/${first.id}`).set('Authorization', root).expect(204);
  assert.equal(photos.length, 1, 'retirement preserves stored district photos');
  await api.put(`/api/object-photo-points/${first.id}/photos`).set('Authorization', editor).set('Content-Type', 'image/jpeg').set('X-Assignment-Version', '1').send(jpeg).expect(404);
  assert.equal((await api.get('/api/object-photo-points').set('Authorization', root)).body.points.length, 1);
});

test('boundary, payload and image checks reject invalid points and disguised uploads', async () => {
  const { api } = fixture(); const root = auth('prefecture_admin');
  for (const changes of [{ longitude: null }, { longitude: '37.5' }, { latitude: 57 }, { district: 'ЦАО' }, { datasetId: 'stops' }, { label: '' }, { note: {} }, { heading: -1 }, { heading: 360 }, { heading: '90' }]) await api.post('/api/object-photo-points').set('Authorization', root).send({ ...assignment, ...changes }).expect(422);
  const p = (await api.post('/api/object-photo-points').set('Authorization', root).send(assignment)).body.point;
  await api.put(`/api/object-photo-points/${p.id}/photos`).set('Authorization', root).set('Content-Type', 'image/png').set('X-Assignment-Version', '1').send(jpeg).expect(422);
  await api.get('/api/object-photo-points/not-a-uuid/photos').set('Authorization', root).expect(400);
});

test('repository persists point metadata and photo bytes transactionally, scopes reads and rolls back audit failure', async () => {
  const calls = []; let failAudit = false; let released = 0;
  const query = async (sql, values) => { calls.push({ sql, values }); if (failAudit && sql.startsWith('INSERT INTO audit_events')) throw new Error('audit failure'); return { rows: [{ id: 'saved', assignment_version: 3, longitude: 37.52, latitude: 55.8 }] }; };
  const pool = { query, async connect() { return { query, release() { released++; } }; } };
  const repo = createObjectPhotoPointRepository(pool);
  await repo.createObjectPhotoPoint({ ...assignment, actorId: 'actor' });
  const saved = calls.find((c) => c.sql.startsWith('INSERT INTO object_photo_points'));
  assert.equal(saved.values[1], assignment.datasetId);
  assert.equal(saved.values[4], assignment.district);
  assert.equal(saved.values[5], assignment.longitude);
  assert.equal(calls[0].sql, 'BEGIN'); assert.equal(calls.at(-1).sql, 'COMMIT');
  await repo.addObjectPhotoPointPhoto({ pointId: 'point', district: 'Аэропорт', expectedVersion: 3, bytes: jpeg, mimeType: 'image/jpeg', filename: 'photo.jpg', actorId: 'actor' });
  const lock = calls.find((c) => c.sql.includes('FOR UPDATE'));
  assert.deepEqual(lock.values, ['point', 'Аэропорт']);
  assert.deepEqual(calls.find((c) => c.sql.startsWith('INSERT INTO object_photo_point_photos')).values[2], jpeg);
  assert.deepEqual(calls.find((c) => c.sql.startsWith('INSERT INTO object_photo_point_photos')).values.slice(7), [3, 37.52, 55.8]);
  await repo.listObjectPhotoPoints({ datasetId: 'sao_tpu_parking' });
  assert.match(calls.at(-1).sql, /f.assignment_version = p.assignment_version/);
  await repo.getObjectPhotoPointPhoto({ pointId: 'point', photoId: 'photo' });
  assert.match(calls.at(-1).sql, /id = \$1 AND point_id = \$2/);
  await repo.getObjectPhotoPoint({ id: 'point', district: 'Сокол' });
  assert.deepEqual(calls.at(-1).values, ['point', 'Сокол']);
  failAudit = true;
  await assert.rejects(repo.updateObjectPhotoPoint({ id: 'point', longitude: 37.6, latitude: 55.5, label: 'label', note: '', actorId: 'actor' }), /audit failure/);
  assert.match(calls.findLast((c) => c.sql.startsWith('UPDATE object_photo_points')).sql, /IS DISTINCT FROM/);
  assert.equal(calls.at(-1).sql, 'ROLLBACK'); assert.equal(released, 3);
});


test('public points expose coordinates without credentials, notes, photos or audit identities', async () => {
  const { api } = fixture();
  const created = await api.post('/api/object-photo-points').set('Authorization', auth('prefecture_admin')).send(assignment).expect(201);
  const result = await api.get('/api/object-photo-points/public').expect(200);
  assert.equal(result.body.points[0].id, created.body.point.id);
  assert.equal(result.body.points[0].longitude, assignment.longitude);
  assert.equal(result.body.points[0].heading, 45);
  assert.equal(result.body.points[0].note, undefined);
  assert.equal(result.body.points[0].created_by, undefined);
  await api.post('/api/object-photo-points').send(assignment).expect(401);
  await api.get(`/api/object-photo-points/${created.body.point.id}/photos`).expect(401);
});


test('repository rejects stale upload versions under the point lock', async () => {
  const calls = [];
  const query = async (sql) => { calls.push(sql); return { rows: [{ id: 'point', assignment_version: 2, longitude: 37.5, latitude: 55.5 }] }; };
  const repo = createObjectPhotoPointRepository({ async connect() { return { query, release() {} }; } });
  await assert.rejects(repo.addObjectPhotoPointPhoto({ pointId: 'point', actorId: 'actor', expectedVersion: 1, bytes: jpeg, mimeType: 'image/jpeg', filename: 'old.jpg' }), error => error.status === 409);
  assert.ok(calls.some(sql => sql.includes('FOR UPDATE')));
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.some(sql => sql.startsWith('INSERT')));
});

test('direction can change independently without moving the point, and survives metadata edits', async () => {
  const { api } = fixture(); const root = auth('prefecture_admin');
  const point = (await api.post('/api/object-photo-points').set('Authorization', root).send(assignment).expect(201)).body.point;
  const turned = (await api.patch('/api/object-photo-points/' + point.id).set('Authorization', root).send({ heading: 270 }).expect(200)).body.point;
  assert.equal(turned.longitude, assignment.longitude);
  assert.equal(turned.latitude, assignment.latitude);
  assert.equal(turned.heading, 270);
  const renamed = (await api.patch('/api/object-photo-points/' + point.id).set('Authorization', root).send({ label: 'Другой ракурс' }).expect(200)).body.point;
  assert.equal(renamed.heading, 270);
  await api.patch('/api/object-photo-points/' + point.id).set('Authorization', root).send({ heading: 360 }).expect(422);
  const publicPoint = (await api.get('/api/object-photo-points/public')).body.points[0];
  assert.equal(publicPoint.heading, 270);
});


test('AvD sees and uploads only its balance-holder objects, districts cannot access them', async () => {
  const { api } = fixture(); const root = auth('prefecture_admin');
  const avd = auth('district_editor', 'АвД САО');
  const avdPoint = (await api.post('/api/object-photo-points').set('Authorization', root)
    .send({ ...assignment, objectKey: 'tpu:800905601', district: 'АвД САО' }).expect(201)).body.point;
  const districtPoint = (await api.post('/api/object-photo-points').set('Authorization', root).send(assignment).expect(201)).body.point;
  const own = await api.get('/api/object-photo-points?district=Аэропорт').set('Authorization', avd).expect(200);
  assert.deepEqual(own.body.points.map(p => p.id), [avdPoint.id]);
  await api.get('/api/object-photo-points/' + districtPoint.id + '/photos').set('Authorization', avd).expect(404);
  await api.get('/api/object-photo-points/' + avdPoint.id + '/photos').set('Authorization', auth('district_editor', 'Ховрино')).expect(404);
  await api.put('/api/object-photo-points/' + avdPoint.id + '/photos').set('Authorization', avd)
    .set('Content-Type', 'image/jpeg').set('X-Assignment-Version', '1').send(jpeg).expect(201);
  await api.post('/api/object-photo-points').set('Authorization', root)
    .send({ ...assignment, district: 'АвД САО' }).expect(422);
  await api.post('/api/object-photo-points').set('Authorization', root)
    .send({ ...assignment, objectKey: 'tpu:800905601' }).expect(422);
});

test('parking assignments are excluded even for prefecture and AvD, including spoofed TPU type', async () => {
  const { api } = fixture(); const root = auth('prefecture_admin');
  for (const input of [
    { ...assignment, objectKey: 'parking:123', objectType: 'parking' },
    { ...assignment, objectKey: 'parking:123', objectType: 'tpu' },
    { ...assignment, objectKey: 'parking:10002419', objectType: 'parking', district: 'АвД САО' }
  ]) {
    assert.equal(validateObjectPhotoPoint(input, boundary).valid, false);
    await api.post('/api/object-photo-points').set('Authorization', root).send(input).expect(422);
  }
});

test('repository hides parking assignments from listings, lookups and photo access', async () => {
  const calls = [];
  const repo = createObjectPhotoPointRepository({ async query(sql) { calls.push(sql); return { rows: [] }; } });
  await repo.listObjectPhotoPoints({ datasetId: 'sao_tpu_parking' });
  await repo.getObjectPhotoPoint({ id: 'point', district: 'АвД САО' });
  assert.ok(calls.every(sql => sql.includes("object_type = 'tpu'")));
});
