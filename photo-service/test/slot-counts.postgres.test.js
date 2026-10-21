import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createSlotRepository } from '../src/tpu-points/object-slots.js';

test('PostgreSQL: число слотов сохраняется, конфликты и гонка загрузки не теряют фото', { skip: !process.env.SLOT_TEST_DATABASE_URL }, async () => {
  const schema = 'slot_test_' + Date.now();
  const pool = new pg.Pool({ connectionString: process.env.SLOT_TEST_DATABASE_URL, options: '-c search_path=' + schema });
  try {
    await pool.query('CREATE SCHEMA ' + schema);
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES ($1)', ['prefecture-test']);
    for (const name of ['014_object_slot_photos.sql', '015_object_slot_counts.sql']) await pool.query(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    const write = async (_actor, _action, _metadata, callback) => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const repo = createSlotRepository(pool, write);
    const input = { objectKey: 'tpu:800905601', actorId: 'prefecture-test', baseRequired: 1 };
    assert.deepEqual(await repo.setSlotCount({ ...input, required: 2, expectedRequired: 1 }), { id: input.objectKey, required: 2 });
    assert.equal((await createSlotRepository(pool, write).listSlotCounts())[0].required, 2);
    const concurrent = await Promise.allSettled([3, 4].map(required => repo.setSlotCount({ ...input, required, expectedRequired: 2 })));
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.find(r => r.status === 'rejected').reason.status, 409);
    const current = (await repo.listSlotCounts())[0].required;
    await repo.setSlotCount({ ...input, required: 3, expectedRequired: current });
    const upload = { ...input, datasetId: 'sao_tpu_parking', slot: 3, district: 'АвД САО', bytes: Buffer.from([255,216,255,217]), mimeType: 'image/jpeg', filename: 'test.jpg' };
    const race = await Promise.allSettled([repo.setSlotCount({ ...input, required: 2, expectedRequired: 3 }), repo.addSlotPhoto(upload)]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(race.find(r => r.status === 'rejected').reason.status, 409);
    const count = (await repo.listSlotCounts())[0].required;
    if (count === 2) { await repo.setSlotCount({ ...input, required: 3, expectedRequired: 2 }); await repo.addSlotPhoto(upload); }
    const photos = await repo.listSlotPhotos({ datasetId: 'sao_tpu_parking' });
    assert.equal(photos.length, 1);
    await repo.reviewSlotPhoto({ id: photos[0].id, decision: 'rejected', comment: 'История', actorId: input.actorId });
    await assert.rejects(repo.setSlotCount({ ...input, required: 2, expectedRequired: 3 }), { status: 409 });
    assert.equal((await repo.getSlotPhotoBytes({ id: photos[0].id })).photo_bytes.length, 4);
  } finally { await pool.query('DROP SCHEMA ' + schema + ' CASCADE'); await pool.end(); }
});
