// Районный набор точек съёмки («эталонные фото»): префектура назначает точки
// со стрелкой направления в своём районе, районная учётка назначать не может.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { createObjectPhotoPointsRouter } from '../src/tpu-points/object-photo-points.js';

const emptyBoundary = { type: 'FeatureCollection', features: [] };
// Широкая граница САО для тестов: проверка «в границах САО» проходит, а районную
// привязку проверяем уже по полигонам districts_wgs84.geojson.
const saoBoundary = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { feature_kind: 'boundary_sao' },
    geometry: { type: 'Polygon', coordinates: [[[36.0, 54.0], [39.0, 54.0], [39.0, 57.0], [36.0, 57.0], [36.0, 54.0]]] },
  }],
};

// Точка внутри Аэропорта (полигоны из districts_wgs84.geojson).
const AEROPORT_INSIDE = { longitude: 37.539, latitude: 55.810 };
// Заведомо вне всех районов.
const FAR_AWAY = { longitude: 37.7, latitude: 55.5 };

async function serve(role, run) {
  const points = [];
  const repository = {
    async listObjectPhotoPoints({ datasetId, district }) {
      return points.filter((p) => p.dataset_id === datasetId && (!district || p.district === district));
    },
    async getObjectPhotoPoint({ id, district }) { return points.find((p) => p.id === id && !p.retired_at && (!district || p.district === district)) || null; },
    async createObjectPhotoPoint(input) {
      // имитация строки БД: поля в snake_case, как у реального репозитория
      const point = {
        id: crypto.randomUUID(), retired_at: null, dataset_id: input.datasetId,
        object_key: input.objectKey, object_type: input.objectType, district: input.district,
        longitude: input.longitude, latitude: input.latitude, label: input.label,
        note: input.note ?? '', heading: input.heading ?? null, created_by: input.actorId,
      };
      points.push(point);
      return point;
    },
    async updateObjectPhotoPoint(input) { const p = points.find((x) => x.id === input.id); if (!p) return null; Object.assign(p, input); return p; },
    async retireObjectPhotoPoint({ id }) { const p = points.find((x) => x.id === id); if (!p) return null; p.retired_at = new Date().toISOString(); return p; },
    async listObjectPhotoPointPhotos() { return []; },
    async addObjectPhotoPointPhoto() { return null; },
    async getObjectPhotoPointPhoto() { return null; },
    async deleteObjectPhotoPointPhoto() { return null; },
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
  try { return await run(base, repository, points); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function districtPoint(overrides = {}) {
  return {
    datasetId: 'sao_district_photo_points', objectKey: 'district:aeroport', objectType: 'district',
    district: 'Аэропорт', ...AEROPORT_INSIDE, label: '1.1', note: '', heading: 45, ...overrides,
  };
}

test('префектура создаёт районную точку съёмки внутри района', async () => {
  await serve('prefecture_admin', async (base, repository, points) => {
    const response = await fetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(districtPoint()) });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.point.dataset_id, 'sao_district_photo_points');
    assert.equal(body.point.object_type, 'district');
    assert.equal(body.point.heading, 45);
    assert.equal(points.length, 1);
  });
});

test('районная точка вне своего района отклоняется с пояснением', async () => {
  await serve('prefecture_admin', async (base, repository, points) => {
    const response = await fetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(districtPoint(FAR_AWAY)) });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.ok(body.details.some((message) => message.includes('своём районе')), 'в ответе есть пояснение про район');
    assert.equal(points.length, 0);
  });
});

test('районная учётка не назначает точки — это префектура', async () => {
  await serve('district_editor', async (base, repository, points) => {
    const response = await fetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(districtPoint()) });
    assert.equal(response.status, 403);
    assert.equal(points.length, 0);
  });
});

test('публичный список отдаёт только районный набор и только свой район', async () => {
  await serve('prefecture_admin', async (base, repository, points) => {
    await repository.createObjectPhotoPoint(districtPoint({ label: '1.1' }));
    await repository.createObjectPhotoPoint(districtPoint({ label: '1.2', district: 'Сокол', longitude: 37.51, latitude: 55.80, objectKey: 'district:sokol' }));
    const response = await fetch(`${base}/public?dataset=sao_district_photo_points&district=${encodeURIComponent('Аэропорт')}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.points.length, 1);
    assert.equal(body.points[0].district, 'Аэропорт');
    assert.equal(body.points[0].label, '1.1');
    assert.equal(body.points[0].heading, 45);
  });
});

test('направление (стрелка) редактируется отдельно от точки', async () => {
  await serve('prefecture_admin', async (base, repository, points) => {
    const created = await repository.createObjectPhotoPoint(districtPoint());
    const response = await fetch(`${base}/${created.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ heading: 180 }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.point.heading, 180);
    assert.equal(body.point.longitude, AEROPORT_INSIDE.longitude, 'координаты точки не тронуты');
  });
});
