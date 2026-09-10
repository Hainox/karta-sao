import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../app.js';
import { hashPassword } from '../lib/auth.js';
import { validateChangeSet } from '../lib/validation.js';

const SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
const boundary = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[37, 55], [38, 55], [38, 56], [37, 56], [37, 55]]] }, properties: {} }]
};

function changeSet({ district = 'Аэропорт', author = 'Иванов И.И.', feature } = {}) {
  return {
    type: 'FeatureCollection', change_set_version: 'district_change_set_v2', district, author,
    created_at: '2026-09-08T10:00:00.000Z', features: [feature || {
      type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.1, 55.1], [37.2, 55.2]] },
      properties: { district, author, change_type: 'queue', queue_priority: '1', address: 'Тестовый маршрут', nozzle_direction: 'both', route_start: [37.1, 55.1], route_end: [37.2, 55.2], route_direction: 'start_to_end' }
    }]
  };
}

async function fixture() {
  const editorPassword = 'editor-password-123';
  const reviewerPassword = 'reviewer-password-123';
  const prefecturePassword = 'prefecture-password-123';
  const users = [
    { id: 'editor-1', email: 'editor@example.test', password_hash: await hashPassword(editorPassword), role: 'district_editor', district: 'Аэропорт' },
    { id: 'unassigned-editor-1', email: 'unassigned@example.test', password_hash: await hashPassword(editorPassword), role: 'district_editor', district: null },
    { id: 'reviewer-1', email: 'reviewer@example.test', password_hash: await hashPassword(reviewerPassword), role: 'reviewer', district: null },
    { id: 'prefecture-1', email: 'prefecture@example.test', password_hash: await hashPassword(prefecturePassword), role: 'prefecture_admin', district: null }
  ];
  const submissions = [];
  const photoMarkers = [];
  const repository = {
    async findUserByEmail(email) { return users.find((user) => user.email === email) || null; },
    async createSubmission(input) {
      const item = { id: `submission-${submissions.length + 1}`, district: input.changeSet.district, author: input.changeSet.author, created_by: input.createdBy, original_filename: input.originalFilename, payload_sha256: input.payloadSha256, change_set: input.changeSet, status: 'submitted', submitted_at: '2026-09-08T10:01:00.000Z' };
      submissions.push(item); return item;
    },
    async listSubmissions({ status, district } = {}) { return submissions.filter((item) => (!status || item.status === status) && (!district || item.district === district)); },
    async reviewSubmission({ id, status, reviewerId, comment }) {
      const item = submissions.find((candidate) => candidate.id === id);
      if (!item) return null;
      Object.assign(item, { status, reviewed_by: reviewerId, review_comment: comment, reviewed_at: '2026-09-08T10:02:00.000Z' }); return item;
    },
    async listPhotoMarkers() { return photoMarkers.map(({ photo_bytes, ...marker }) => ({ ...marker, has_photo: Boolean(photo_bytes) })); },
    async createPhotoMarker({ longitude, latitude, note, legacySourceId, createdBy }) {
      const existing = legacySourceId && photoMarkers.find((marker) => marker.legacy_source_id === legacySourceId);
      if (existing) return { ...existing, has_photo: Boolean(existing.photo_bytes), imported: true };
      const marker = { id: `photo-marker-${photoMarkers.length + 1}`, longitude, latitude, note, legacy_source_id: legacySourceId, created_by: createdBy, photo_bytes: null, photo_mime_type: null, photo_filename: null, photo_size: null, created_at: '2026-09-08T10:03:00.000Z', updated_at: '2026-09-08T10:03:00.000Z' };
      photoMarkers.push(marker); return { ...marker, has_photo: false };
    },
    async updatePhotoMarkerNote({ id, note }) { const marker = photoMarkers.find((candidate) => candidate.id === id); if (!marker) return null; marker.note = note; return { ...marker, has_photo: Boolean(marker.photo_bytes) }; },
    async setPhotoMarkerPhoto({ id, bytes, mimeType, filename }) { const marker = photoMarkers.find((candidate) => candidate.id === id); if (!marker) return null; Object.assign(marker, { photo_bytes: bytes, photo_mime_type: mimeType, photo_filename: filename, photo_size: bytes.length }); return { ...marker, has_photo: true }; },
    async getPhotoMarkerPhoto(id) { const marker = photoMarkers.find((candidate) => candidate.id === id); return marker ? { photo_bytes: marker.photo_bytes, photo_mime_type: marker.photo_mime_type, photo_filename: marker.photo_filename } : null; },
    async deletePhotoMarkerPhoto({ id }) { const marker = photoMarkers.find((candidate) => candidate.id === id); if (!marker?.photo_bytes) return null; Object.assign(marker, { photo_bytes: null, photo_mime_type: null, photo_filename: null, photo_size: null }); return { ...marker, has_photo: false }; },
    async deletePhotoMarker({ id }) { const index = photoMarkers.findIndex((candidate) => candidate.id === id); if (index < 0) return null; return photoMarkers.splice(index, 1)[0]; }
  };
  return { api: request(createApp({ repository, boundary, jwtSecret: SECRET, allowedOrigins: ['https://map.example.test'] })), editorPassword, reviewerPassword, prefecturePassword };
}

async function login(api, email, password) {
  const response = await api.post('/api/auth/login').send({ email, password }).expect(200);
  return response.body.token;
}

function binaryParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

test('валидирует зоны накопления роторного снега', () => {
  const polygon = [[37.1, 55.1], [37.2, 55.1], [37.2, 55.2], [37.1, 55.1]];
  const set = changeSet({ feature: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [polygon] }, properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'rotor_snow_storage_zone', address: 'Тестовая зона' } } });
  assert.deepEqual(validateChangeSet(set, boundary), { valid: true, errors: [] });
});

test('авторизация, районные права, приёмка и выгрузка работают по API', async () => {
  const { api, editorPassword, reviewerPassword } = await fixture();
  await api.get('/api/me').expect(401);
  const editor = await login(api, 'editor@example.test', editorPassword);
  await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: changeSet({ district: 'Беговой' }) }).expect(403);
  const unassigned = await login(api, 'unassigned@example.test', editorPassword);
  await api.post('/api/submissions').set('Authorization', `Bearer ${unassigned}`).send({ changeSet: changeSet() }).expect(403);
  const submitted = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: changeSet(), originalFilename: 'airport.geojson' }).expect(201);
  await api.patch(`/api/submissions/${submitted.body.submission.id}`).set('Authorization', `Bearer ${editor}`).send({ status: 'approved' }).expect(403);
  const reviewer = await login(api, 'reviewer@example.test', reviewerPassword);
  const archive = await api.get('/api/exports/review-archive.zip').set('Authorization', `Bearer ${reviewer}`).buffer(true).parse(binaryParser).expect(200);
  assert.match(archive.headers['content-type'], /application\/zip/);
  assert.match(archive.headers['content-disposition'], /pravki-sao-k-priemke/);
  assert.equal(archive.body.subarray(0, 2).toString(), 'PK');
  assert.match(archive.body.toString('utf8'), /manifest\.json/);
  assert.match(archive.body.toString('utf8'), /районы\/Аэропорт\//);
  await api.patch(`/api/submissions/${submitted.body.submission.id}`).set('Authorization', `Bearer ${reviewer}`).send({ status: 'approved', comment: 'Проверено' }).expect(200);
  const exported = await api.get('/api/exports/approved.geojson').set('Authorization', `Bearer ${reviewer}`).expect(200);
  assert.equal(exported.body.review_status, 'approved');
  assert.equal(exported.body.sources.length, 1);
  assert.equal(exported.body.features[0].properties.review_status, 'approved');
});

test('отклоняет неверный маршрут до сохранения', async () => {
  const { api, editorPassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  const invalid = changeSet({ feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.1, 55.1], [39, 57]] }, properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'queue', queue_priority: '1', address: 'За границей' } } });
  const response = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: invalid }).expect(422);
  assert.match(response.body.details.join('\n'), /вне границы САО/);
});

test('фото-метки и снимки доступны только префектуре и удаляются полностью', async () => {
  const { api, reviewerPassword, prefecturePassword } = await fixture();
  const reviewer = await login(api, 'reviewer@example.test', reviewerPassword);
  await api.get('/api/photo-markers').set('Authorization', `Bearer ${reviewer}`).expect(403);
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);
  await api.post('/api/photo-markers').set('Authorization', `Bearer ${prefecture}`).send({ longitude: 39, latitude: 57 }).expect(422);
  const created = await api.post('/api/photo-markers').set('Authorization', `Bearer ${prefecture}`).send({ longitude: 37.2, latitude: 55.2, note: 'До уборки' }).expect(201);
  const markerId = created.body.photoMarker.id;
  await api.patch(`/api/photo-markers/${markerId}`).set('Authorization', `Bearer ${prefecture}`).send({ note: 'После уборки' }).expect(200);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const uploaded = await api.put(`/api/photo-markers/${markerId}/photo`).set('Authorization', `Bearer ${prefecture}`).set('Content-Type', 'image/jpeg').set('X-Photo-Filename', 'inspection.jpg').send(jpeg).expect(200);
  assert.equal(uploaded.body.photoMarker.has_photo, true);
  const downloaded = await api.get(`/api/photo-markers/${markerId}/photo`).set('Authorization', `Bearer ${prefecture}`).buffer(true).parse(binaryParser).expect(200);
  assert.match(downloaded.headers['content-type'], /image\/jpeg/);
  assert.deepEqual(downloaded.body, jpeg);
  await api.delete(`/api/photo-markers/${markerId}/photo`).set('Authorization', `Bearer ${prefecture}`).expect(200);
  await api.get(`/api/photo-markers/${markerId}/photo`).set('Authorization', `Bearer ${prefecture}`).expect(404);
  await api.delete(`/api/photo-markers/${markerId}`).set('Authorization', `Bearer ${prefecture}`).expect(204);
  const listed = await api.get('/api/photo-markers').set('Authorization', `Bearer ${prefecture}`).expect(200);
  assert.equal(listed.body.photoMarkers.length, 0);
});
