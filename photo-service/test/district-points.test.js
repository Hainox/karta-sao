// Районный набор точек съёмки («эталонные фото»): точки ставит префектура либо
// районная учётка — свой район и с приёмкой префектурой; чужих точек не трогают.
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
    async listObjectPhotoPoints({ datasetId, district, acceptedOnly = false, excludePrefectureArchive = false, excludeImported = false }) {
      return points.filter((p) => p.dataset_id === datasetId && (!district || p.district === district)
        && (!acceptedOnly || (p.review_status || 'accepted') === 'accepted')
        && (!excludePrefectureArchive || new Date(p.created_at).getTime() >= Date.parse('2026-10-23T08:00:00.000Z'))
        && (!excludeImported || !(p.note || '').startsWith('Источник:')));
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
        assignment_version: 1, created_at: input.createdAt || new Date().toISOString(),
        review_status: input.reviewStatus || 'accepted', review_comment: input.reviewComment || '',
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
    async updateObjectPhotoPoint(input) {
      const p = points.find((x) => x.id === input.id);
      if (!p) return null;
      const { reviewStatus, ...rest } = input;
      Object.assign(p, rest);
      if (reviewStatus) {
        p.review_status = reviewStatus;
        if (reviewStatus === 'pending') { p.review_comment = ''; p.reviewed_by = null; p.reviewed_at = null; }
      }
      return p;
    },
    async listDistrictPointReviewQueue() { return points.filter((p) => p.dataset_id === 'sao_district_photo_points' && p.review_status === 'pending' && !p.retired_at); },
    async reviewDistrictPoint({ id, decision, comment, actorId }) {
      const p = points.find((x) => x.id === id && x.review_status === 'pending' && !x.retired_at);
      if (!p) return null;
      p.review_status = decision;
      p.review_comment = comment;
      p.reviewed_by = actorId;
      p.reviewed_at = new Date().toISOString();
      return p;
    },
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

test('районная учётка отправляет свою точку на приёмку префектуре', async () => {
  await serve('district_editor', async (base, repository, points) => {
    const response = await fetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(districtPoint()) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).point.review_status, 'pending');
    assert.equal(points.length, 1);
  });
});

test('районная учётка не создаёт точку в чужом районе', async () => {
  await serve('district_editor', async (base, repository, points) => {
    const response = await fetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(districtPoint({ district: 'Сокол', objectKey: 'district:sokol', longitude: 37.51, latitude: 55.80 })) });
    assert.equal(response.status, 403);
    assert.equal(points.length, 0);
  });
});

test('публичный список отдаёт только районный набор, свой район и без ожидающих приёмки', async () => {
  await serve('prefecture_admin', async (base, repository, points) => {
    await repository.createObjectPhotoPoint(districtPoint({ label: '1.1', reviewStatus: 'accepted' }));
    await repository.createObjectPhotoPoint(districtPoint({ label: '1.2', reviewStatus: 'pending' }));
    await repository.createObjectPhotoPoint(districtPoint({ label: '1.3', district: 'Сокол', longitude: 37.51, latitude: 55.80, objectKey: 'district:sokol' }));
    const response = await fetch(`${base}/public?dataset=sao_district_photo_points&district=${encodeURIComponent('Аэропорт')}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.points.map((point) => point.label), ['1.1']);
    assert.equal(body.points[0].district, 'Аэропорт');
    assert.equal(body.points[0].heading, 45);
  });
});

test('очередь приёмки точек доступна только префектуре и ждёт только pending', async () => {
  await serve('district_editor', async (base) => {
    const response = await fetch(`${base}/review-queue`);
    assert.equal(response.status, 403);
  });
  await serve('prefecture_admin', async (base, repository) => {
    const pending = await repository.createObjectPhotoPoint(districtPoint({ label: '1.1', reviewStatus: 'pending' }));
    await repository.createObjectPhotoPoint(districtPoint({ label: '1.2', reviewStatus: 'accepted' }));
    const response = await fetch(`${base}/review-queue`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).points.map((point) => point.id), [pending.id]);
  });
});

test('префектура принимает или возвращает точку на доработку', async () => {
  await serve('prefecture_admin', async (base, repository) => {
    const point = await repository.createObjectPhotoPoint(districtPoint({ reviewStatus: 'pending' }));
    const response = await fetch(`${base}/${point.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'rework', comment: 'Уточнить направление съёмки.' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.point.review_status, 'rework');
    assert.equal(body.point.review_comment, 'Уточнить направление съёмки.');

    const noComment = await fetch(`${base}/${point.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'rework', comment: '  ' }),
    });
    assert.equal(noComment.status, 422, 'возврат без комментария не проходит');
  });
});

test('районная учётка не принимает точку сама', async () => {
  await serve('district_editor', async (base, repository) => {
    const point = await repository.createObjectPhotoPoint(districtPoint({ reviewStatus: 'pending' }));
    const response = await fetch(`${base}/${point.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'accepted', comment: '' }),
    });
    assert.equal(response.status, 403);
  });
});

test('район правит свою ожидающую точку и возвращает её на приёмку', async () => {
  await serve('district_editor', async (base, repository) => {
    const point = await repository.createObjectPhotoPoint(districtPoint({ reviewStatus: 'rework', reviewComment: 'Уточнить направление.' }));
    const response = await fetch(`${base}/${point.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: '1.1 исправлено' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.point.label, '1.1 исправлено');
    assert.equal(body.point.review_status, 'pending', 'после правки точка снова на приёмке');
    assert.equal(body.point.review_comment, '', 'старый комментарий префектуры очищен');
  });
  await serve('district_editor', async (base, repository) => {
    const accepted = await repository.createObjectPhotoPoint(districtPoint({ reviewStatus: 'accepted' }));
    const response = await fetch(`${base}/${accepted.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'подмена' }),
    });
    assert.equal(response.status, 403, 'принятую точку район не правит');
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

test('районная учётка не меняет принятую точку (подпись и координаты)', async () => {
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

test('районная учётка не загружает фото, пока точка не принята префектурой', async () => {
  await serve('district_editor', async (base, repository, _points, photos) => {
    const point = await repository.createObjectPhotoPoint(districtPoint({ reviewStatus: 'pending' }));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const response = await fetch(`${base}/${point.id}/photos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'X-Assignment-Version': '1', 'X-Photo-Filename': 'et.jpg' },
      body: jpeg,
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /приёмк/);
    assert.equal(photos.length, 0, 'слот не открыт');
  });
});

test('префектура выгружает отдельную сводку по фото (Excel)', async () => {
  await serve('prefecture_admin', async (base, repository) => {
    await repository.createObjectPhotoPoint(districtPoint({ label: '1.1', reviewStatus: 'accepted' }));
    const response = await fetch(`${base}/report.xlsx?dataset=sao_district_photo_points&report=photos`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /spreadsheetml/);
    assert.match(response.headers.get('content-disposition') || '', /Svodka_Foto_Rayonov_SAO_/);
  });
});

test('публичный список не отдаёт импортные точки (NextGIS, GPKG) — они только для префектуры', async () => {
  await serve('prefecture_admin', async (base, repository) => {
    const regular = await repository.createObjectPhotoPoint(districtPoint({ label: 'обычная' }));
    await repository.createObjectPhotoPoint(districtPoint({ label: 'импорт', note: 'Источник: Коровинское.gpkg; fid=2.' }));
    const response = await fetch(`${base}/public?dataset=sao_district_photo_points&district=${encodeURIComponent('Аэропорт')}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.points.map((point) => point.id), [regular.id]);
  });
});

test('районная учётка видит только обычные точки района, префектура — все', async () => {
  await serve('district_editor', async (base, repository) => {
    const regular = await repository.createObjectPhotoPoint(districtPoint({ label: 'обычная' }));
    await repository.createObjectPhotoPoint(districtPoint({ label: 'импорт', note: 'Источник: NextGIS; id=7.' }));
    const response = await fetch(`${base}/?dataset=sao_district_photo_points&district=${encodeURIComponent('Аэропорт')}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).points.map((point) => point.id), [regular.id]);
  });
  await serve('prefecture_admin', async (base, repository) => {
    await repository.createObjectPhotoPoint(districtPoint({ label: 'обычная' }));
    await repository.createObjectPhotoPoint(districtPoint({ label: 'импорт', note: 'Источник: NextGIS; id=7.' }));
    const response = await fetch(`${base}/?dataset=sao_district_photo_points&district=${encodeURIComponent('Аэропорт')}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).points.length, 2);
  });
});

test('районная учётка не открывает импортную точку и не грузит в неё фото', async () => {
  await serve('district_editor', async (base, repository, points, photos) => {
    const imported = await repository.createObjectPhotoPoint(districtPoint({ label: 'импорт', note: 'Источник: NextGIS; id=7.' }));
    const listResponse = await fetch(`${base}/${imported.id}/photos`);
    assert.equal(listResponse.status, 404);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const putResponse = await fetch(`${base}/${imported.id}/photos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'X-Assignment-Version': '1', 'X-Photo-Filename': 'et.jpg' },
      body: jpeg,
    });
    assert.equal(putResponse.status, 404);
    assert.equal(photos.length, 0);
  });
});
