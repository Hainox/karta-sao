// Кабинет приёмки, режим «Пешеходные дорожки АСУ ОДС»: каталог точек вдоль
// трассы, загрузка префектурой, приёмка и свод.
import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createPedestrianPathsRouter, pathLabel, pedestrianQueueFromRows } from '../src/tpu-points/pedestrian-paths.js';

const POINT = '5e9480d8-b5b6-5a46-9f91-ece0a7a7cf11';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const rows = [
  {
    point_id: 'p1', point_no: 'ПД-1-01', path_id: 1, ordinal: 1, district: 'Коптево',
    address: 'Коптевская ул. 1', longitude: 37.57, latitude: 55.83, route_m: 40, area: 21, coating: 'Асфальт',
    photo_id: 'f1', photo_status: 'pending', uploaded_at: '2026-11-11T08:00:00Z', photo_filename: 'a.jpg',
  },
  {
    point_id: 'p2', point_no: 'ПД-2-02', path_id: 2, ordinal: 2, district: 'Сокол',
    address: 'Волоколамское шоссе 16', longitude: 37.5, latitude: 55.81, route_m: 320, area: 90, coating: 'Плитка',
    rejected_photo_id: 'f0', rejected_comment: 'Дорожка не в кадре', rejected_at: '2026-11-10T10:00:00Z',
    rejected_uploaded_at: '2026-11-10T08:00:00Z',
  },
  {
    point_id: 'p3', point_no: 'ПД-3-01', path_id: 3, ordinal: 1, district: 'Сокол',
    address: 'Ленинградский пр-т 1', longitude: 37.51, latitude: 55.8, route_m: 80, area: 30, coating: 'Асфальт',
    photo_id: 'f3', photo_status: 'accepted', uploaded_at: '2026-11-09T08:00:00Z',
  },
  {
    point_id: 'p4', point_no: 'ПД-4-01', path_id: 4, ordinal: 1, district: 'Коптево',
    address: '', longitude: 37.58, latitude: 55.84, route_m: 12, area: 8, coating: '',
  },
];

test('каталог дорожек: счёт по состояниям и точки без фото', () => {
  const queue = pedestrianQueueFromRows(rows);
  assert.deepEqual(queue.counts, { total: 4, empty: 1, pending: 1, accepted: 1, rework: 1 });
  assert.equal(queue.pending[0].point_no, 'ПД-1-01');
  assert.equal(queue.rework[0].rejected_comment, 'Дорожка не в кадре');
  assert.equal(queue.rework[0].path_id, 2);
  assert.deepEqual(queue.empty.map((row) => row.point_no), ['ПД-4-01']);
  assert.equal(queue.empty[0].label, 'Дорожка 4');
});

test('подпись точки: адрес и номер вдоль трассы', () => {
  assert.equal(pathLabel({ address: 'Коптевская ул. 1', ordinal: 1, path_id: 1 }), 'Коптевская ул. 1');
  assert.equal(pathLabel({ address: 'Коптевская ул. 1', ordinal: 3, path_id: 1 }), 'Коптевская ул. 1 · точка 3');
  assert.equal(pathLabel({ address: '', ordinal: 1, path_id: 7 }), 'Дорожка 7');
});

async function serve(pool, role, run) {
  const app = express();
  app.use(express.json());
  app.use('/pedestrian-paths', createPedestrianPathsRouter({
    pool,
    authenticate: (req, _res, next) => {
      req.user = { sub: 'u', role, district: role === 'district_editor' ? 'Коптево' : null };
      next();
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}/pedestrian-paths`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const readPool = { query: async () => ({ rows, rowCount: rows.length }) };

test('очередь и свод дорожек доступны только префектуре', async () => {
  await serve(readPool, 'prefecture_admin', async (base) => {
    const queue = await (await fetch(`${base}/queue`)).json();
    assert.equal(queue.counts.total, 4);
    assert.equal(queue.empty.length, 1);
    const response = await fetch(`${base}/report.xlsx`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /Svod_foto_peshehodnye_dorozhki_SAO_\d{4}-\d{2}-\d{2}\.xlsx/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
    assert.equal(book.getWorksheet('Свод по районам').getCell('A1').value, 'Пешеходные дорожки · АСУ ОДС');
  });
  for (const role of ['district_editor', 'reviewer']) {
    await serve(readPool, role, async (base) => {
      assert.equal((await fetch(`${base}/queue`)).status, 403);
      assert.equal((await fetch(`${base}/report.xlsx`)).status, 403);
    });
  }
});

function uploadPool({ active = false } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FOR UPDATE')) return { rows: [{ id: POINT }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM pedestrian_path_photos')) return { rows: active ? [{}] : [], rowCount: active ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { calls, connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) };
}

const upload = (base, body = PNG, role = 'prefecture_admin') => fetch(`${base}/${POINT}/photo`, {
  method: 'PUT', headers: { 'content-type': 'image/png', 'x-photo-filename': 'path.png' }, body,
});

test('префектура загружает фото — оно встаёт на проверку', async () => {
  const pool = uploadPool();
  await serve(pool, 'prefecture_admin', async (base) => {
    const response = await upload(base);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).status, 'pending');
    assert.ok(pool.calls.some((sql) => sql.includes('INSERT INTO pedestrian_path_photos')));
    assert.ok(pool.calls.includes('COMMIT'));
  });
});

test('район и проверяющий не могут загружать дорожки; второе активное фото запрещено', async () => {
  for (const role of ['district_editor', 'reviewer']) {
    await serve(uploadPool(), role, async (base) => assert.equal((await upload(base)).status, 403));
  }
  const pool = uploadPool({ active: true });
  await serve(pool, 'prefecture_admin', async (base) => {
    assert.equal((await upload(base)).status, 409);
    assert.ok(!pool.calls.some((sql) => sql.includes('INSERT INTO pedestrian_path_photos')));
  });
});

test('поддельный файл отклоняется до записи', async () => {
  const pool = uploadPool();
  await serve(pool, 'prefecture_admin', async (base) => {
    assert.equal((await upload(base, Buffer.from('bad'))).status, 422);
    assert.ok(!pool.calls.some((sql) => sql.includes('INSERT INTO pedestrian_path_photos')));
  });
});

function reviewPool({ pending = true } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('UPDATE pedestrian_path_photos')) return { rows: pending ? [{ id: 'f1' }] : [], rowCount: pending ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { calls, connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) };
}

const review = (base, body) => fetch(`${base}/${POINT}/review`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('приёмка: без причины возврата нельзя, принятие и возврат работают', async () => {
  await serve(reviewPool(), 'prefecture_admin', async (base) => {
    assert.equal((await review(base, { decision: 'rejected' })).status, 422);
    assert.equal((await review(base, { decision: 'rejected', comment: 'Не тот ракурс' })).status, 200);
    assert.equal((await review(base, { decision: 'accepted' })).status, 200);
  });
  await serve(reviewPool({ pending: false }), 'prefecture_admin', async (base) => {
    assert.equal((await review(base, { decision: 'accepted' })).status, 409);
  });
});
