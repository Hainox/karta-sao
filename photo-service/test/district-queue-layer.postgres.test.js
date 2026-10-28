// Кабинет приёмки и свод по въездным группам считают ровно точки слоя
// «Точки съёмки · въездные группы» на картах районов: без импортных (NextGIS/GPKG),
// без архива до 23.10.2026 11:00 и без неподтверждённых точек.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createObjectPhotoPointRepository } from '../src/tpu-points/object-photo-points.js';
import { districtQueueFromRows } from '../src/tpu-points/district-point-photos.js';

const MIGRATIONS = ['008_tpu_photo_points.sql', '009_tpu_photo_point_heading.sql', '013_district_photo_points.sql', '017_district_point_photo_slots.sql', '018_district_point_review.sql'];

test('PostgreSQL: очередь кабинета въездных групп совпадает со слоем карты района', { skip: !process.env.SLOT_TEST_DATABASE_URL }, async () => {
  const schema = 'district_queue_layer_' + Date.now();
  const pool = new pg.Pool({ connectionString: process.env.SLOT_TEST_DATABASE_URL, options: '-c search_path=' + schema });
  try {
    await pool.query('CREATE SCHEMA ' + schema);
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES ($1)', ['prefecture-test']);
    for (const name of MIGRATIONS) await pool.query(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    const repository = createObjectPhotoPointRepository(pool, { writeAudit: async () => {} });
    const create = (label, note = '') => repository.createObjectPhotoPoint({
      datasetId: 'sao_district_photo_points', objectType: 'district', objectKey: 'district:aeroport',
      district: 'Аэропорт', longitude: 37.539, latitude: 55.81, label, note, heading: 45, actorId: 'prefecture-test',
    });
    const layer = await create('1.1');
    const imported = await create('1.2', 'Источник: NextGIS, слой «САО»');
    const archive = await create('1.3');
    const unconfirmed = await create('1.4');
    await pool.query("UPDATE object_photo_points SET created_at = TIMESTAMPTZ '2026-10-20 10:00:00+03' WHERE id = $1", [archive.id]);
    await pool.query("UPDATE object_photo_points SET review_status = 'pending' WHERE id = $1", [unconfirmed.id]);

    const queue = districtQueueFromRows(await repository.listDistrictPointPhotoQueue());
    const mapLayer = await repository.listObjectPhotoPoints({
      datasetId: 'sao_district_photo_points', acceptedOnly: true, excludePrefectureArchive: true, excludeImported: true,
    });
    assert.deepEqual(mapLayer.map((point) => point.id), [layer.id], 'слой карты: только обычная точка');
    assert.equal(queue.counts.total, 1, 'кабинет считает только точки слоя');
    assert.equal(queue.counts.empty, 1);
    assert.ok(!queue.pending.concat(queue.rework).some((row) => [imported.id, archive.id, unconfirmed.id].includes(row.point_id)));
  } finally {
    await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {});
    await pool.end();
  }
});
