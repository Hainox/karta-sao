import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import ExcelJS from 'exceljs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSidewalkTestLayerRouter } from '../src/tpu-points/sidewalk-test-layer.js';

const point = { id: 'AVD-P01', taskId: 'AVD', district: 'Аэропорт', balance: 'АВД САО', street: 'Переулок', coordinates: [37.51, 55.81],
  sidewalkId: '10001', roadId: '20001', slots: [{ id: 'AVD-P01-F01', azimuth: 24.9, sidewalkIds: '10001' }, { id: 'AVD-P01-F02', azimuth: 204.9, sidewalkIds: '10001' }] };

test('закрытый слой отдаёт отдельные азимуты слотов только префектуре и только по выбранному району', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidewalk-test-'));
  const catalogPath = join(dir, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ version: 1, points: [point, { ...point, id: 'P02', district: 'Коптево', slots: [{ id: 'P02-F01', azimuth: 0, sidewalkIds: '10001' }] }] }));
  const editsPath = join(dir, 'edits.json');
  const app = express();
  app.use(express.json());
  const makeRouter = () => createSidewalkTestLayerRouter({ catalogPath, editsPath, authenticate: (req, res, next) => {
    const role = req.get('x-test-role');
    if (!role) return res.sendStatus(401);
    req.user = { role, district: 'Аэропорт' };
    next();
  } });
  let router = makeRouter();
  app.use((req, res, next) => router(req, res, next));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const root = 'http://127.0.0.1:' + server.address().port;
  const get = (role, district = 'Аэропорт') => fetch(root + '/?district=' + encodeURIComponent(district), { headers: role ? { 'x-test-role': role } : {} });
  try {
    assert.equal((await get()).status, 401);
    for (const role of ['district_editor', 'reviewer', 'avd_editor']) assert.equal((await get(role)).status, 403);
    assert.equal((await get('prefecture_admin', 'Другой район')).status, 400);
    const response = await get('prefecture_admin');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await response.json()).points, [point]);
    const patch = (body, role = 'prefecture_admin') => fetch(root + '/AVD-P01', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body),
    });
    assert.equal((await patch({ coordinates: [37.52, 55.82] }, 'district_editor')).status, 403);
    assert.equal((await patch({ slotId: 'P02-F01', azimuth: 10 })).status, 404);
    assert.equal((await patch({ slotId: point.slots[0].id, azimuth: 360 })).status, 400);
    assert.equal((await patch({ coordinates: [55.82, 37.52] })).status, 400);
    const results = await Promise.all([
      patch({ coordinates: [37.52, 55.82] }),
      patch({ slotId: point.slots[0].id, azimuth: 89.5 }),
    ]);
    assert.deepEqual(results.map(r => r.status), [200, 200]);
    const flagged = (role) => fetch(root + '/no-sidewalk', { headers: { 'x-test-role': role } });
    assert.equal((await flagged('district_editor')).status, 403);
    assert.equal((await patch({ noSidewalk: true }, 'district_editor')).status, 403);
    assert.equal((await patch({ noSidewalk: 'true' })).status, 400);
    assert.equal((await patch({ noSidewalk: true })).status, 200);
    router = makeRouter();
    const edited = (await (await get('prefecture_admin')).json()).points[0];
    assert.deepEqual(edited.coordinates, [37.52, 55.82]);
    assert.deepEqual(edited.slots.map(s => s.azimuth), [89.5, 204.9]);
    assert.equal(edited.noSidewalk, true);
    assert.deepEqual((await (await flagged('prefecture_admin')).json()).points, [{ id: point.id, district: point.district, street: point.street }]);
    assert.equal((await patch({ noSidewalk: false })).status, 200);
    assert.deepEqual((await (await flagged('prefecture_admin')).json()).points, []);
    await rm(catalogPath);
    // В пределах процесса используется одна проверенная версия набора.
    assert.equal((await get('prefecture_admin')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('АвД получает только свои точки из разных районов и не может менять геометрию или чужие пометки', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidewalk-avd-'));
  const catalogPath = join(dir, 'catalog.json');
  const second = { ...point, id: 'AVD-P02', district: 'Коптево', slots: [{ id: 'AVD-P02-F01', azimuth: 0 }] };
  const other = { ...point, id: 'DISTRICT-P01', district: 'Коптево', balance: 'Аэропорт', slots: [{ id: 'DISTRICT-P01-F01', azimuth: 90 }] };
  await writeFile(catalogPath, JSON.stringify({ version: 1, points: [point, second, other] }));
  const dbCalls = [];
  const photoRows = [];
  const client = {
    query: async (sql, args) => {
      if (String(sql).includes('INSERT INTO avd_sidewalk_test_photos')) {
        photoRows.push({ frame_id: 'AVD-P01-F01', id: 'photo-1', status: 'pending', uploaded_at: '2026-11-06T10:00:00Z', review_comment: null, reviewed_at: null });
      }
      return { rows: [{ id: 'photo-1', status: 'pending' }] };
    },
    release() {},
  };
  const pool = {
    async query(sql, args) {
      dbCalls.push({ sql, args });
      return /avd_sidewalk_test_photos/.test(sql) ? { rows: photoRows } : { rows: [] };
    },
    async connect() { return client; },
  };
  const app = express();
  app.use(express.json());
  app.use(createSidewalkTestLayerRouter({
    catalogPath, editsPath: join(dir, 'edits.json'), pool,
    authenticate(req, res, next) {
      const actor = req.get('x-actor');
      if (!actor) return res.sendStatus(401);
      req.user = { id: actor, role: actor === 'pref' ? 'prefecture_admin' : 'district_editor', district: actor === 'avd' ? 'АвД САО' : 'Аэропорт' };
      next();
    },
  }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const root = 'http://127.0.0.1:' + server.address().port;
  const request = (path, actor, options = {}) => fetch(root + path, {
    ...options, headers: { ...options.headers, ...(actor ? { 'x-actor': actor } : {}) },
  });
  const patch = (id, actor, body) => request('/' + id, actor, {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
  const frame = '/avd/frames/';
  try {
    assert.equal((await request('/avd')).status, 401);
    assert.equal((await request('/avd', 'district')).status, 403);
    assert.equal((await request('/?district=Аэропорт', 'avd')).status, 403);
    const response = await request('/avd', 'avd');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const data = await response.json();
    assert.deepEqual(data.points.map(p => p.id), [point.id, second.id]);
    assert.deepEqual(data.points[0].slots.map(s => [s.id, s.azimuth, s.status]), [
      ['AVD-P01-F01', 24.9, 'empty'], ['AVD-P01-F02', 204.9, 'empty'],
    ]);
    assert.equal((await request('/avd/queue', 'avd')).status, 403);
    assert.equal((await request(frame + other.slots[0].id + '/photos/00000000-0000-0000-0000-000000000001', 'avd')).status, 404);
    assert.equal((await request(frame + other.slots[0].id + '/photo', 'avd', {
      method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([255, 216, 255, 217]),
    })).status, 404);
    assert.equal((await patch(point.id, 'avd', { coordinates: [37.52, 55.82] })).status, 403);
    assert.equal((await patch(point.id, 'avd', { slotId: point.slots[0].id, azimuth: 45 })).status, 403);
    assert.equal((await patch(other.id, 'avd', { noSidewalk: true })).status, 404);
    assert.equal((await patch(point.id, 'avd', { noSidewalk: true })).status, 200);
    // Пометка «Нет тротуара» больше не мешает загрузке: кадр уходит в приёмку с меткой.
    assert.equal((await request(frame + point.slots[0].id + '/photo', 'avd', {
      method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([255, 216, 255, 217]),
    })).status, 201);
    const queued = await (await request('/avd/queue', 'pref')).json();
    assert.deepEqual(queued.pending.map(row => [row.label, row.no_sidewalk]), [['Переулок · AVD-P01 · кадр 1', true]]);
    assert.equal((await request('/no-sidewalk', 'avd')).status, 403);
    assert.deepEqual((await (await request('/no-sidewalk', 'pref')).json()).points.map(p => p.id), [point.id]);
    assert.equal((await patch(point.id, 'avd', { noSidewalk: false })).status, 200);
    assert.equal(dbCalls.length, 2, 'запрещённые обращения к чужим слотам не читают БД (очередь + список)');
    assert.equal((await request('/district')).status, 401);
    assert.equal((await request('/district', 'avd')).status, 403);
    const own = await request('/district?district=Коптево', 'district');
    assert.equal(own.status, 200);
    assert.deepEqual((await own.json()).points.map(p => [p.id, p.district, p.slots[0].status]), [[other.id, 'Коптево', 'empty']]);
    const jpg = { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([255, 216, 255, 217]) };
    assert.equal((await request('/district/frames/' + point.slots[0].id + '/photo', 'district', jpg)).status, 404);
    assert.equal((await request('/district/queue', 'district')).status, 403);
    assert.equal((await patch(other.id, 'district', { noSidewalk: true })).status, 200);
    // И здесь пометка не блокирует кадр: слот точки «Нет тротуара» принимает фото.
    assert.equal((await request('/district/frames/' + other.slots[0].id + '/photo', 'district', jpg)).status, 201);
    assert.equal((await patch(other.id, 'district', { noSidewalk: false })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('своды Excel по тротуарам ОДХ: районы и АвД получают отдельные книги как у въездных групп', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidewalk-report-'));
  const catalogPath = join(dir, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ version: 1, points: [
    point,
    { ...point, id: 'DISTRICT-P01', district: 'Коптево', balance: 'Аэропорт', street: 'Улица', slots: [{ id: 'DISTRICT-P01-F01', azimuth: 90 }] },
  ] }));
  const pool = { async query(sql) {
    if (!/avd_sidewalk_test_photos/.test(sql)) return { rows: [] };
    return { rows: [
      { frame_id: 'AVD-P01-F01', id: '1', status: 'accepted', uploaded_at: '2026-11-05T10:00:00Z', reviewed_at: '2026-11-05T11:00:00Z', review_comment: null },
      { frame_id: 'DISTRICT-P01-F01', id: '2', status: 'rejected', uploaded_at: '2026-11-05T09:00:00Z', reviewed_at: '2026-11-05T10:00:00Z', review_comment: 'исправить' },
    ] };
  } };
  const app = express();
  app.use(express.json());
  app.use(createSidewalkTestLayerRouter({
    catalogPath, editsPath: join(dir, 'edits.json'), pool,
    authenticate(req, res, next) {
      const actor = req.get('x-actor');
      if (!actor) return res.sendStatus(401);
      req.user = { id: actor, role: actor === 'pref' ? 'prefecture_admin' : 'district_editor', district: actor === 'avd' ? 'АвД САО' : 'Аэропорт' };
      next();
    },
  }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const root = 'http://127.0.0.1:' + server.address().port;
  const workbook = async (path, actor = 'pref') => {
    const response = await fetch(root + path, { headers: { 'x-actor': actor } });
    if (response.status !== 200) return { response, book: null };
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
    return { response, book };
  };
  try {
    for (const path of ['/avd/report.xlsx', '/district/report.xlsx']) {
      assert.equal((await workbook(path, 'avd')).response.status, 403, 'свод видит только префектура');
      assert.equal((await workbook(path, 'district')).response.status, 403);
    }
    const avd = await workbook('/avd/report.xlsx');
    assert.match(avd.response.headers.get('content-type'), /spreadsheetml/);
    assert.match(avd.response.headers.get('content-disposition'), /Svod_foto_trotuary_odh_avd_SAO_/);
    assert.deepEqual(avd.book.worksheets.map(w => w.name), ['Свод по районам', 'Точки', 'На доработке']);
    assert.equal(avd.book.getWorksheet('Свод по районам').getCell('A1').value, 'Оцифровка тротуаров ОДХ · АвД САО');
    // Два слота точки АвД: один принятый кадр и один без фото.
    assert.equal(avd.book.getWorksheet('Точки').rowCount, 3);
    assert.equal(avd.book.getWorksheet('На доработке').getCell('A2').value, 'Точек на доработке нет.');
    const odh = await workbook('/district/report.xlsx');
    assert.match(odh.response.headers.get('content-disposition'), /Svod_foto_trotuary_odh_SAO_/);
    assert.equal(odh.book.getWorksheet('Свод по районам').getCell('A1').value, 'Оцифровка тротуаров ОДХ');
    assert.equal(odh.book.getWorksheet('На доработке').getCell('B2').value, 'Улица · DISTRICT-P01 · кадр 1');
    // Возврат района пришёл в лист доработки с причиной.
    assert.equal(odh.book.getWorksheet('На доработке').getCell('C2').value, 'исправить');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
