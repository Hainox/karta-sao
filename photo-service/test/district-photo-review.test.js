// Кабинет приёмки районных точек: очередь доступна только префектуре,
// решение по фото — принять или отклонить с комментарием, повторное
// отклонение не ломает кабинет.
import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import { createObjectPhotoPointsRouter } from '../src/tpu-points/object-photo-points.js';
import { districtQueueFromRows, pointState } from '../src/tpu-points/district-point-photos.js';

const saoBoundary = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { feature_kind: 'boundary_sao' },
    geometry: { type: 'Polygon', coordinates: [[[36.0, 54.0], [39.0, 54.0], [39.0, 57.0], [36.0, 57.0], [36.0, 54.0]]] },
  }],
};

const PHOTO_ACCEPTED_ID = '9499f2e0-da51-4d51-91cb-4b43dfae44af';

async function serve(role, run) {
  const reviewCalls = [];
  const queueRows = [
    {
      point_id: 'point-pending-old', label: '1.1', district: 'Аэропорт', heading: 45, longitude: 37.539, latitude: 55.81,
      photo_id: 'photo-old', photo_status: 'pending', uploaded_at: '2026-10-21T10:00:00Z', photo_filename: 'old.jpg',
      rejected_comment: null, rejected_at: null,
    },
    {
      point_id: 'point-pending-new', label: '1.2', district: 'Аэропорт', heading: 90, longitude: 37.541, latitude: 55.812,
      photo_id: 'photo-new', photo_status: 'pending', uploaded_at: '2026-10-21T12:00:00Z', photo_filename: 'new.jpg',
      rejected_comment: null, rejected_at: null,
    },
    {
      point_id: 'point-rework', label: '1.3', district: 'Аэропорт', heading: 0, longitude: 37.542, latitude: 55.813,
      photo_id: null, photo_status: null, uploaded_at: null, photo_filename: null,
      rejected_comment: 'Снимок без клумбы в кадре', rejected_at: '2026-10-21T15:00:00Z',
    },
    {
      point_id: 'point-accepted', label: '1.4', district: 'Аэропорт', heading: 180, longitude: 37.543, latitude: 55.814,
      photo_id: 'photo-accepted', photo_status: 'accepted', uploaded_at: '2026-10-21T09:00:00Z', photo_filename: 'ok.jpg',
      rejected_comment: null, rejected_at: null,
    },
  ];
  const repository = {
    async listObjectPhotoPoints() { return []; },
    async listDistrictPointPhotoQueue() { return queueRows; },
    async reviewDistrictPointPhoto(input) {
      reviewCalls.push(input);
      if (input.id === PHOTO_ACCEPTED_ID) return null; // фото уже отклонено — слот ждёт новый снимок
      return { id: input.id, status: input.decision, review_comment: input.comment };
    },
  };
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/object-photo-points', createObjectPhotoPointsRouter({
    repository,
    authenticate: (req, _res, next) => { req.user = { id: 'user', role, district: role === 'district_editor' ? 'Аэропорт' : null, sub: 'user' }; next(); },
    boundary: saoBoundary,
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/object-photo-points`;
  try {
    return await run({ base, queueRows, reviewed: () => reviewCalls });
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('состояние точки собирается из активного и отклонённого фото', () => {
  const queueRows = (extra = {}) => ({ photo_id: null, photo_status: null, uploaded_at: null, photo_filename: null, rejected_comment: null, rejected_at: null, ...extra });
  assert.equal(pointState(queueRows({ photo_status: 'pending', photo_id: 'p1', uploaded_at: '2026-10-21T10:00:00Z' })).status, 'pending');
  assert.equal(pointState(queueRows({ photo_status: 'accepted', photo_id: 'p2', rejected_comment: 'прошлая правка', rejected_at: '2026-10-21T09:00:00Z' })).status, 'accepted');
  assert.equal(pointState(queueRows({ rejected_comment: 'комментарий' })).status, 'rework');
  assert.equal(pointState(queueRows()).status, 'empty');
  const rework = pointState(queueRows({ rejected_comment: 'Переснять' }));
  assert.equal(rework.status, 'rework');
  assert.equal(rework.rejected.comment, 'Переснять');
});

test('очередь ждёт дольше всех первыми и считает точки по состояниям', () => {
  const now = '2026-10-21T10:00:00Z';
  const later = '2026-10-21T11:00:00Z';
  const queue = districtQueueFromRows([
    { point_id: 'b', label: '2', district: 'Беговой', heading: null, photo_id: '2', photo_status: 'pending', uploaded_at: later, rejected_comment: null, rejected_at: null },
    { point_id: 'a', label: '1', district: 'Аэропорт', heading: null, photo_id: '1', photo_status: 'pending', uploaded_at: now, rejected_comment: null, rejected_at: null },
    { point_id: 'c', label: '3', district: 'Войковский', heading: null, photo_id: null, photo_status: null, uploaded_at: null, rejected_comment: 'Переснять', rejected_at: '2026-10-21T08:00:00Z' },
  ]);
  assert.deepEqual(queue.counts, { total: 3, empty: 0, pending: 2, accepted: 0, rework: 1 });
  assert.deepEqual(queue.pending.map((row) => row.point_id), ['a', 'b']);
  assert.equal(queue.rework[0].rejected_comment, 'Переснять');
  assert.equal(queue.rework[0].label, '3');
});

test('очередь кабинета доступна только префектуре', async () => {
  await serve('district_editor', async ({ base }) => {
    const denied = await fetch(base + '/district-photos/queue');
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'Фото точек съёмки проверяет только префектура.');
    const notAllowed = await fetch(base + `/district-photos/photos/${PHOTO_ACCEPTED_ID}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accepted', comment: '' }),
    });
    assert.equal(notAllowed.status, 403);
  });
  await serve('prefecture_admin', async ({ base }) => {
    const response = await fetch(base + '/district-photos/queue');
    assert.equal(response.status, 200);
    const queue = await response.json();
    assert.deepEqual(queue.counts, { total: 4, empty: 0, pending: 2, accepted: 1, rework: 1 });
    assert.equal(queue.pending[0].point_id, 'point-pending-old');
    assert.equal(queue.pending[0].heading, 45);
    assert.equal(queue.rework[0].rejected_comment, 'Снимок без клумбы в кадре');
  });
});

test('решение принимает или отклоняет фото по правилам кабинета', async () => {
  await serve('prefecture_admin', async ({ base, reviewed }) => {
    const accepted = await fetch(base + `/district-photos/photos/4917ba9f-fa5d-4a86-8f04-1a5ea1fe3c1e/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accepted', comment: '' }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual((await accepted.json()).photo, { id: '4917ba9f-fa5d-4a86-8f04-1a5ea1fe3c1e', status: 'accepted', review_comment: '' });

    const invalid = await fetch(base + `/district-photos/photos/4917ba9f-fa5d-4a86-8f04-1a5ea1fe3c1e/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'maybe' }),
    });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error, 'Укажите решение: принять или отклонить.');

    const withoutComment = await fetch(base + `/district-photos/photos/4917ba9f-fa5d-4a86-8f04-1a5ea1fe3c1e/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'rejected', comment: '   ' }),
    });
    assert.equal(withoutComment.status, 422);
    assert.equal((await withoutComment.json()).error, 'Напишите, что не так и что исправить.');

    const rejected = await fetch(base + `/district-photos/photos/4917ba9f-fa5d-4a86-8f04-1a5ea1fe3c1e/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'rejected', comment: 'Снимок размыт' }),
    });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).photo.status, 'rejected');

    const stale = await fetch(base + `/district-photos/photos/${PHOTO_ACCEPTED_ID}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accepted', comment: '' }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'Фото уже отклонено. Дождитесь нового снимка от района.');

    assert.equal(reviewed().length, 3);
    assert.deepEqual(reviewed()[0], { id: '4917ba9f-fa5d-4a86-8f04-1a5ea1fe3c1e', decision: 'accepted', comment: '', actorId: 'user' });
  });
});
