import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createObjectPhotoPointRepository } from '../src/tpu-points/object-photo-points.js';
import { districtQueueFromRows } from '../src/tpu-points/district-point-photos.js';

const MIGRATIONS = ['008_tpu_photo_points.sql', '009_tpu_photo_point_heading.sql', '013_district_photo_points.sql', '017_district_point_photo_slots.sql', '018_district_point_review.sql'];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
// Точка внутри Аэропорта (полигоны districts_wgs84.geojson).
const AEROPORT = { longitude: 37.539, latitude: 55.81 };

test('PostgreSQL: у районной точки один слот, отклонение открывает его заново, перенос сохраняет фото', { skip: !process.env.SLOT_TEST_DATABASE_URL }, async () => {
  const schema = 'district_photo_test_' + Date.now();
  const pool = new pg.Pool({ connectionString: process.env.SLOT_TEST_DATABASE_URL, options: '-c search_path=' + schema });
  const audit = [];
  try {
    await pool.query('CREATE SCHEMA ' + schema);
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES ($1)', ['prefecture-test']);
    for (const name of MIGRATIONS) {
      await pool.query(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
      if (name === '017_district_point_photo_slots.sql') {
        // Миграция идемпотентна: повторный прогон не ломает схему.
        await pool.query(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
      }
    }
    const repository = createObjectPhotoPointRepository(pool, { writeAudit: async (_client, { eventType }) => { audit.push(eventType); } });

    const point = await repository.createObjectPhotoPoint({
      datasetId: 'sao_district_photo_points',
      objectType: 'district',
      objectKey: 'district:aeroport:001',
      district: 'Аэропорт',
      longitude: AEROPORT.longitude,
      latitude: AEROPORT.latitude,
      label: '1.1',
      note: '',
      heading: 45,
      actorId: 'prefecture-test',
    });

    const upload = (version, filename = 'aeroport-1.jpg') => repository.addObjectPhotoPointPhoto({
      pointId: point.id, district: null, bytes: JPEG, mimeType: 'image/jpeg', filename, actorId: 'prefecture-test', expectedVersion: version,
    });

    const first = await upload(1);
    assert.equal(first.status, 'pending');
    assert.equal(first.dataset_id, 'sao_district_photo_points');

    // Слоты один: на проверке или принятое фото на точке уже есть.
    await assert.rejects(upload(1), (error) => error.status === 409);

    // Кабинет видит точку на проверке (и она ждёт дольше всех, если их несколько).
    let queue = districtQueueFromRows(await repository.listDistrictPointPhotoQueue());
    assert.deepEqual(queue.counts, { total: 1, empty: 0, pending: 1, accepted: 0, rework: 0 });
    assert.equal(queue.pending[0].photo_id, first.id);
    assert.equal(queue.pending[0].heading, 45);

    const rejectedPhoto = await repository.reviewDistrictPointPhoto({
      id: first.id, decision: 'rejected', comment: 'Снимок размыт, переснимите у входа', actorId: 'prefecture-test',
    });
    assert.equal(rejectedPhoto.status, 'rejected');
    assert.equal(rejectedPhoto.review_comment, 'Снимок размыт, переснимите у входа');

    // Отклонённое фото не проверяется повторно: репозиторий возвращает null,
    // а маршрут отвечает 409 «дождитесь нового снимка».
    const stale = await repository.reviewDistrictPointPhoto({ id: first.id, decision: 'accepted', comment: '', actorId: 'prefecture-test' });
    assert.equal(stale, null);

    queue = districtQueueFromRows(await repository.listDistrictPointPhotoQueue());
    assert.deepEqual(queue.counts, { total: 1, empty: 0, pending: 0, accepted: 0, rework: 1 });
    assert.equal(queue.rework[0].rejected_comment, 'Снимок размыт, переснимите у входа');

    // Перенос точки и смена направления не перетирают слот: версия не меняется,
    // повторная загрузка идёт с той же привязкой и отклонённое фото остаётся историей.
    const moved = await repository.updateObjectPhotoPoint({
      id: point.id, longitude: AEROPORT.longitude + 0.0005, latitude: AEROPORT.latitude, label: '1.1', note: '', heading: 90, actorId: 'prefecture-test', keepAssignmentVersion: true,
    });
    assert.equal(moved.assignment_version, 1);

    const second = await upload(1, 'aeroport-2.jpg');
    assert.equal(second.status, 'pending');

    const accepted = await repository.reviewDistrictPointPhoto({ id: second.id, decision: 'accepted', comment: '', actorId: 'prefecture-test' });
    assert.equal(accepted.status, 'accepted');

    // Слот снова занят — принятое фото держит его.
    await assert.rejects(upload(1, 'aeroport-3.jpg'), (error) => error.status === 409 && error.message.includes('уже есть фото'));

    // Публичный список показывает состояние слота, поведение набора ТПУ прежнее.
    const districtRows = await repository.listObjectPhotoPoints({ datasetId: 'sao_district_photo_points' });
    assert.equal(districtRows[0].photo_state, 'accepted');
    assert.equal(districtRows[0].photo_count, 2);
    const tpuRows = await repository.listObjectPhotoPoints({ datasetId: 'sao_tpu_parking' });
    assert.equal(tpuRows.length, 0);

    queue = districtQueueFromRows(await repository.listDistrictPointPhotoQueue());
    assert.deepEqual(queue.counts, { total: 1, empty: 0, pending: 0, accepted: 1, rework: 0 });
    assert.ok(audit.includes('district_point_photo_reviewed'));
  } finally {
    await pool.end();
  }
});

test('PostgreSQL: перенос точки ТПУ по-прежнему перетирает привязку снимков', { skip: !process.env.SLOT_TEST_DATABASE_URL }, async () => {
  const schema = 'district_photo_unused_' + Date.now();
  const pool = new pg.Pool({ connectionString: process.env.SLOT_TEST_DATABASE_URL, options: '-c search_path=' + schema });
  const write = { writeAudit: async () => {} };
  try {
    await pool.query('CREATE SCHEMA ' + schema);
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES ($1)', ['prefecture-test']);
    for (const name of MIGRATIONS) await pool.query(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    const repository = createObjectPhotoPointRepository(pool, write);

    const point = await repository.createObjectPhotoPoint({
      datasetId: 'sao_tpu_parking', objectType: 'tpu', objectKey: 'tpu:test', district: 'Аэропорт',
      longitude: AEROPORT.longitude, latitude: AEROPORT.latitude, label: 'ТПУ', note: '', actorId: 'prefecture-test',
    });
    await repository.addObjectPhotoPointPhoto({ pointId: point.id, district: null, bytes: JPEG, mimeType: 'image/jpeg', filename: 'tpu.jpg', actorId: 'prefecture-test', expectedVersion: 1 });
    // ТПУ: перенос без keepAssignmentVersion растит версию точки, снимок
    // прежней версии больше попадает в счёт карточки, статус вложения прежний.
    await repository.updateObjectPhotoPoint({ id: point.id, longitude: AEROPORT.longitude + 0.001, latitude: AEROPORT.latitude, label: 'ТПУ', note: '', actorId: 'prefecture-test' });
    const rows = await repository.listObjectPhotoPoints({ datasetId: 'sao_tpu_parking' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].assignment_version, 2);
    assert.equal(rows[0].photo_count, 0);
    const held = await repository.listObjectPhotoPointPhotos(point.id);
    assert.equal(held[0].status, 'accepted');
    assert.equal(held[0].dataset_id, 'sao_tpu_parking');
  } finally {
    await pool.end();
  }
});
