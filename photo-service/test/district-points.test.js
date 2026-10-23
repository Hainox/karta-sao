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
  const photos = [];
  const repository = {
    async listObjectPhotoPoints({ datasetId, district, excludePrefectureArchive = false }) {
      return points.filter((p) => p.dataset_id === datasetId && (!district || p.district === district)
        && (!excludePrefectureArchive || new Date(p.created_at).getTime() >= Date.parse('2026-10-23T08:00:00.000Z')));
    },
    async listPrefectureArchivePoints({ district }) {
      return points.filter((p) => p.dataset_id === 'sao_district_photo_points' && (!district || p.district === district)
        && new Date(p.created_at).getTime() < Date.parse('2026-10-23T08:00:00.000Z'));
    },
    async getObjectPhotoPoint({ id, district }) { return points.find((p) => p.id === id && !p.retired_at && (!district || p.district === district)) || null; },
    async createObjectPhotoPoint(input) {
      // имитация строки БД: поля в snake_case, как у реального репозитория
      const point = {
        id: crypto.randomUUID(), retired_at: null, dataset_id: input.datasetId,
        object_key: input.objectKey, object_type: input.objectType, district: input.district,
        longitude: input.longitude, latitude: input.latitude, label: input.label,
        note: input.note ?? '', heading: input.heading ?? null, created_by: input.actorId,
        assignment_version: 1, created_at: new Date().toISOString(),
      };
      points.push(point);
      return point;
    },
    async addObjectPhotoPointPhoto({ pointId, filename, expectedVersion }) {
      const point = points.find((p) => p.id === pointId);
      if (!point || point.assignment_version !== expectedVersion) return null;
      const photo = { id: crypto.randomUUID(), point_id: pointId, photo_filename: filename };
      photos.push(photo);
      return photo;
    },
    async updateObjectPhotoPoint(input) { const p = points.find((x) => x.id === input.id); if (!p) return null; Object.assign(p, input); return p; },
    async retireObjectPhotoPoint({ id }) { const p = points.find((x) => x.id === id); if (!p) return null; p.retired_at = new Date().toISOString(); return p; },
    async listObjectPhotoPointPhotos(pointId) { return photos.filter((p) => p.point_id === pointId); },
    async tpuReportData({ datasetId }) { return { points: points.filter((p) => p.dataset_id === datasetId), daily: [] }; },
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
  try { return await run(base, repository, points, photos); }
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

test('архивные точки видны только префектуре и не попадают в обычный список', async () => {
  await serve('prefecture_admin', async (base, repository, points) => {
    const archived = await repository.createObjectPhotoPoint(districtPoint({ label: 'архив' }));
    archived.created_at = '2026-10-23T07:59:59.999Z';
    const current = await repository.createObjectPhotoPoint(districtPoint({ label: 'новая' }));
    current.created_at = '2026-10-23T08:00:00.000Z';

    const archiveResponse = await fetch(`${base}/prefecture-archive?district=${encodeURIComponent('Аэропорт')}`);
    assert.equal(archiveResponse.status, 200);
    assert.deepEqual((await archiveResponse.json()).points.map((point) => point.id), [archived.id]);

    const ordinaryResponse = await fetch(`${base}/?dataset=sao_district_photo_points&district=${encodeURIComponent('Аэропорт')}`);
    assert.deepEqual((await ordinaryResponse.json()).points.map((point) => point.id), [current.id]);

    const publicResponse = await fetch(`${base}/public?dataset=sao_district_photo_points&district=${encodeURIComponent('Аэропорт')}`);
    assert.deepEqual((await publicResponse.json()).points.map((point) => point.id), [current.id]);
    assert.equal(points.length, 2);
  });
});

test('архивный слой и фото старых точек недоступны районной учётке', async () => {
  await serve('district_editor', async (base, repository) => {
    const archived = await repository.createObjectPhotoPoint(districtPoint({ label: 'архив' }));
    archived.created_at = '2026-10-23T07:59:59.999Z';
    const archiveResponse = await fetch(`${base}/prefecture-archive?district=${encodeURIComponent('Аэропорт')}`);
    assert.equal(archiveResponse.status, 403);
    const photoResponse = await fetch(`${base}/${archived.id}/photos`);
    assert.equal(photoResponse.status, 404);
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

test('префектура редактирует подпись, координаты, азимут и примечание точки', async () => {
  await serve('prefecture_admin', async (base, repository, points) => {
    const created = await repository.createObjectPhotoPoint(districtPoint());
    const changes = {
      label: 'Коровинское · 002', longitude: 37.54, latitude: 55.811,
      heading: 271.5, note: 'Источник: Коровинское.gpkg; fid=2.',
    };
    const response = await fetch(`${base}/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
    });
    assert.equal(response.status, 200);
    const { point } = await response.json();
    assert.equal(point.label, changes.label);
    assert.equal(point.longitude, changes.longitude);
    assert.equal(point.latitude, changes.latitude);
    assert.equal(point.heading, changes.heading);
    assert.equal(point.note, changes.note);
    assert.equal(points.length, 1, 'редактирование не создаёт дубликат точки');
  });
});

test('районная учётка не меняет подпись и координаты точки', async () => {
  await serve('district_editor', async (base, repository) => {
    const created = await repository.createObjectPhotoPoint(districtPoint());
    const response = await fetch(`${base}/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'подмена' }),
    });
    assert.equal(response.status, 403);
  });
});

test('префектура выгружает сводку районных точек (Excel)', async () => {
  await serve('prefecture_admin', async (base, repository, points) => {
    await repository.createObjectPhotoPoint(districtPoint({ label: '1.1' }));
    const response = await fetch(`${base}/report.xlsx?dataset=sao_district_photo_points`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /spreadsheetml/);
  });
});

test('сводка районных точек недоступна районной учётке', async () => {
  await serve('district_editor', async (base) => {
    const response = await fetch(`${base}/report.xlsx?dataset=sao_district_photo_points`);
    assert.equal(response.status, 403);
  });
});

test('районная учётка отправляет фото к точке своего района (текущий ракурс)', async () => {
  await serve('district_editor', async (base, repository, points, photos) => {
    const point = await repository.createObjectPhotoPoint(districtPoint());
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const response = await fetch(`${base}/${point.id}/photos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'X-Assignment-Version': '1', 'X-Photo-Filename': 'et.jpg' },
      body: jpeg,
    });
    assert.equal(response.status, 201);
    assert.equal(photos.length, 1, 'фото записано');
    assert.equal(photos[0].point_id, point.id);
  });
});
