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
  const users = [
    { id: 'editor-1', email: 'editor@example.test', password_hash: await hashPassword(editorPassword), role: 'district_editor', district: 'Аэропорт' },
    { id: 'reviewer-1', email: 'reviewer@example.test', password_hash: await hashPassword(reviewerPassword), role: 'reviewer', district: null }
  ];
  const submissions = [];
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
    }
  };
  return { api: request(createApp({ repository, boundary, jwtSecret: SECRET, allowedOrigins: ['https://map.example.test'] })), editorPassword, reviewerPassword };
}

async function login(api, email, password) {
  const response = await api.post('/api/auth/login').send({ email, password }).expect(200);
  return response.body.token;
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
  const submitted = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: changeSet(), originalFilename: 'airport.geojson' }).expect(201);
  await api.patch(`/api/submissions/${submitted.body.submission.id}`).set('Authorization', `Bearer ${editor}`).send({ status: 'approved' }).expect(403);
  const reviewer = await login(api, 'reviewer@example.test', reviewerPassword);
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
