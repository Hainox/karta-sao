// Прямая проверка копии маршрутизатора точек съёмки, которая работает в фотослужбе
// (у api есть своя копия, она тестируется отдельно). Здесь именно удаление одного
// кадра: точка съёмки и её направление остаются на месте, а из хранилища фото исчезает.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { createObjectPhotoPointsRouter } from '../src/tpu-points/object-photo-points.js';

const emptyBoundary = { type: 'FeatureCollection', features: [] };

async function serve(role, run) {
  const points = []; const photos = [];
  const repository = {
    async listObjectPhotoPoints() { return points; },
    async getObjectPhotoPoint({ id, district }) { return points.find((p) => p.id === id && !p.retired_at && (!district || p.district === district)) || null; },
    async createObjectPhotoPoint(input) { const point = { id: crypto.randomUUID(), retired_at: null, ...input }; points.push(point); return point; },
    async updateObjectPhotoPoint() { return null; },
    async retireObjectPhotoPoint() { return null; },
    async listObjectPhotoPointPhotos(pointId) { return photos.filter((p) => p.point_id === pointId); },
    async addObjectPhotoPointPhoto(input) { const photo = { id: crypto.randomUUID(), point_id: input.pointId, photo_filename: input.filename }; photos.push(photo); return photo; },
    async getObjectPhotoPointPhoto() { return null; },
    async deleteObjectPhotoPointPhoto({ pointId, photoId }) { const index = photos.findIndex((p) => p.point_id === pointId && p.id === photoId); return index < 0 ? null : photos.splice(index, 1)[0]; },
  };
  const app = express();
  app.use('/object-photo-points', createObjectPhotoPointsRouter({
    repository,
    authenticate: (req, _res, next) => { req.user = { id: 'user', role, district: role === 'district_editor' ? 'Аэропорт' : null, sub: 'user' }; next(); },
    boundary: emptyBoundary,
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/object-photo-points`;
  try { return await run(base, repository, points, photos); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('фотослужба удаляет один кадр, сохраняя точку съёмки и направление', async () => {
  await serve('prefecture_admin', async (base, repository, points, photos) => {
    const point = await repository.createObjectPhotoPoint({ datasetId: 'sao_tpu_parking', objectKey: 'tpu:757159046', objectType: 'tpu', district: 'АвД САО', longitude: 37.47488, latitude: 55.854038, label: '4', note: '', heading: 47.9 });
    const photo = await repository.addObjectPhotoPointPhoto({ pointId: point.id, filename: 'rechnoy.jpg' });
    assert.equal((await fetch(`${base}/${point.id}/photos/${photo.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(photos.length, 0, 'кадр удалён из хранилища');
    assert.equal(points.length, 1, 'точка съёмки остаётся');
    assert.equal(points[0].heading, 47.9, 'направление (стрелка) сохраняется');
    assert.equal((await fetch(`${base}/${point.id}/photos/${photo.id}`, { method: 'DELETE' })).status, 404);
  });
});

test('районная учётка не может удалять кадры — это действие префектуры', async () => {
  await serve('district_editor', async (base, repository, points, photos) => {
    const point = await repository.createObjectPhotoPoint({ datasetId: 'sao_tpu_parking', objectKey: 'tpu:123', objectType: 'tpu', district: 'Аэропорт', longitude: 37.5, latitude: 55.5, label: '1', note: '', heading: 10 });
    const photo = await repository.addObjectPhotoPointPhoto({ pointId: point.id, filename: 'x.jpg' });
    assert.equal((await fetch(`${base}/${point.id}/photos/${photo.id}`, { method: 'DELETE' })).status, 403);
    assert.equal(photos.length, 1, 'кадр не удалён');
  });
});
