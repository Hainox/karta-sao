// Google-таблица пешеходных дорожек: срез, превью по токену и решения.
import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import {
  applyPathSheetDecision, attachPathPhotoTokens, createPedestrianPathSheetRouter,
  pathSheetRows, validatePathSheetDecisions,
} from '../src/tpu-points/pedestrian-path-sheet.js';

const POINT = '5e9480d8-b5b6-5a46-9f91-ece0a7a7cf11';
const PHOTO = '7f2b9a4c-1d3e-4f50-8a6b-9c0d1e2f3a4b';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const base = {
  point_id: POINT, point_no: 'ПД-1-01', path_id: 1, ordinal: 1, district: 'Коптево',
  address: 'Коптевская ул. 1', longitude: 37.57, latitude: 55.83, route_m: 40, area: 21, coating: 'Асфальт',
};

test('строка таблицы: активный кадр, возврат и пустая точка', () => {
  const rows = pathSheetRows([
    { ...base, photo_id: 'f1', photo_status: 'pending', uploaded_at: '2026-11-11T08:00:00Z' },
    { ...base, point_id: 'p2', rejected_photo_id: 'f0', rejected_comment: 'Не в кадре', rejected_at: '2026-11-10T10:00:00Z' },
    { ...base, point_id: 'p3', photo_id: 'f3', photo_status: 'accepted', uploaded_at: '2026-11-09T08:00:00Z' },
    { ...base, point_id: 'p4' },
  ]);
  assert.equal(rows[0].photo_state, 'pending');
  assert.equal(rows[0].preview_photo_id, 'f1');
  assert.equal(rows[1].photo_state, 'rework');
  assert.equal(rows[1].preview_photo_id, 'f0');
  assert.equal(rows[1].rejected_comment, 'Не в кадре');
  assert.equal(rows[2].photo_state, 'accepted');
  assert.equal(rows[3].photo_state, 'empty');
  assert.equal(rows[3].preview_photo_id, null);
});

test('токен превью создаётся один раз на снимок', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push(sql);
      if (sql.startsWith('SELECT photo_id, token')) return { rows: [{ photo_id: PHOTO, token: 'a'.repeat(32) }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const rows = [{ ...base, preview_photo_id: PHOTO }, { ...base, point_id: 'p2' }];
  const result = await attachPathPhotoTokens(pool, rows);
  assert.equal(result[0].photo_token, 'a'.repeat(32));
  assert.equal(result[1].photo_token, null);
  assert.ok(!calls.some((sql) => sql.includes('INSERT INTO pedestrian_path_sheet_tokens')));
});

test('валидация решений: адресность и обязательная причина возврата', () => {
  const good = validatePathSheetDecisions({ decisions: [{
    client_id: 'c1', point_id: POINT, photo_id: PHOTO, decision: 'accepted',
  }] });
  assert.equal(good.decisions.length, 1);
  assert.equal(good.decisions[0].decision, 'accepted');

  assert.match(validatePathSheetDecisions({ decisions: [] }).error, /Нет решений/);
  assert.match(validatePathSheetDecisions({ decisions: [{ client_id: 'c', point_id: 'x', photo_id: PHOTO, decision: 'accepted' }] }).error, /point_id/);
  assert.match(validatePathSheetDecisions({ decisions: [{ client_id: 'c', point_id: POINT, photo_id: 'x', decision: 'accepted' }] }).error, /photo_id/);
  assert.match(validatePathSheetDecisions({ decisions: [{ client_id: 'c', point_id: POINT, photo_id: PHOTO, decision: 'rework' }] }).error, /причину/);
});

function decisionPool() {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('INSERT INTO pedestrian_path_sheet_reviews')) return { rows: [{ id: 'r1' }], rowCount: 1 };
      if (sql.includes('SELECT status FROM pedestrian_path_photos')) return { rows: [{ status: 'accepted' }], rowCount: 1 };
      if (sql.includes('UPDATE pedestrian_path_photos')) return { rows: [{ id: PHOTO }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { calls, connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) };
}

const item = (decision, extra = {}) => ({
  client_id: 'c1', point_id: POINT, photo_id: PHOTO, decision, reason: null, comment: null,
  reviewed_by: 'sheet', reviewed_at: new Date('2026-11-11T09:00:00Z'), ...extra,
});

test('принятие и возврат меняют снимок, проверка — только журнал', async () => {
  const accept = decisionPool();
  const accepted = await applyPathSheetDecision(accept, item('accepted'), 'u1');
  assert.equal(accepted.applied, true);
  assert.equal(accepted.status, 'accepted');
  assert.ok(accept.calls.some((sql) => sql.includes("status = 'accepted'")));

  const rework = decisionPool();
  const returned = await applyPathSheetDecision(rework, item('rework', { reason: 'Не в кадре' }), 'u1');
  assert.equal(returned.applied, true);
  assert.equal(returned.status, 'rejected');
  assert.ok(rework.calls.some((sql) => sql.includes("status = 'rejected'")));

  const verify = decisionPool();
  const verified = await applyPathSheetDecision(verify, item('verified'), 'u1');
  assert.equal(verified.applied, true);
  assert.ok(!verify.calls.some((sql) => sql.includes('UPDATE pedestrian_path_photos')));
});

async function serve(pool, role, run) {
  const app = express();
  app.use(express.json());
  app.use('/sheet', createPedestrianPathSheetRouter({
    pool,
    authenticate: (req, _res, next) => { req.user = { sub: 'u', role }; next(); },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}/sheet`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('срез и решения доступны только префектуре; превью — по токену', async () => {
  const rows = [{ ...base }];
  const pool = {
    async query(sql) {
      if (sql.includes('FROM pedestrian_path_points')) return { rows, rowCount: rows.length };
      if (sql.includes('FROM pedestrian_path_sheet_tokens')) return { rows: [{ photo_id: PHOTO, point_id: POINT }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM pedestrian_path_photos')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('FROM pedestrian_path_sheet_thumbs')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT photo_bytes FROM pedestrian_path_photos')) return { rows: [{ photo_bytes: PNG }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  await serve(pool, 'prefecture_admin', async (url) => {
    const sheet = await (await fetch(`${url}/sheet.json`)).json();
    assert.equal(sheet.rows.length, 1);
    assert.equal(sheet.rows[0].photo_state, 'empty');
    const thumb = await fetch(`${url}/photo-thumb/${'a'.repeat(32)}`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  });
  await serve(pool, 'district_editor', async (url) => {
    assert.equal((await fetch(`${url}/sheet.json`)).status, 403);
  });
  await serve(pool, 'prefecture_admin', async (url) => {
    assert.equal((await fetch(`${url}/photo-thumb/not-a-token`)).status, 404);
  });
});
