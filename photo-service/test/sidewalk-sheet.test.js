import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createCanvas } from '@napi-rs/canvas';
import {
  applySheetDecision, attachPhotoTokens, createSidewalkSheetRouter, odhSheetRows, validateSheetDecisions, yardsSheetRows,
} from '../src/tpu-points/sidewalk-sheet.js';
import { mergePoint } from '../src/tpu-points/sidewalk-test-layer.js';

const POINT = '5e9480d8-b5b6-5a46-9f91-ece0a7a7cf11';
const PHOTO = '4b209796-bcf5-4f12-9cbe-ce4c9f9342a8';
const REJECTED = '9c2a0e64-0bd9-4a35-9f0e-2bd4b7c8a111';
const FRAME = 'ОМК-1-007-2';
const TOKEN = 'b'.repeat(32);

const jpeg = () => {
  const canvas = createCanvas(800, 600);
  canvas.getContext('2d').fillRect(0, 0, 800, 600);
  return canvas.toBuffer('image/jpeg', 85);
};

const response = () => ({
  headers: {},
  set(name, value) { this.headers[name] = value; return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
  type(value) { this.headers['Content-Type'] = value; return this; },
  send(body) { this.body = body; return this; },
});

const run = (router, path, request) => {
  const index = router.stack.findIndex(layer => layer.route?.path === path);
  assert.ok(index >= 0, `маршрут ${path} зарегистрирован`);
  return { handler: router.stack[index].route.stack.at(-1).handle, index };
};

const yardRow = (overrides = {}) => ({
  point_id: POINT, point_no: 'Т1.386', district: 'Беговой', address: 'Беговая ул. 6 к.3', role: 'тротуар', side: 'чётная',
  heading: 90, longitude: 37.5, latitude: 55.7,
  photo_id: PHOTO, photo_status: 'accepted', uploaded_at: '2026-11-01T10:00:00Z', reviewed_at: '2026-11-02T10:00:00Z', review_comment: '',
  rejected_photo_id: null, rejected_comment: null, rejected_at: null,
  ...overrides,
});

const frameSource = (overrides = {}) => ({
  id: 'ОДХ-1-007', district: 'Беговой', street: 'Беговая ул. 6', balance: 'ГБУ «Жилищник района Беговой»',
  coordinates: [37.51, 55.71], slots: [{ id: 'F1', azimuth: 10 }, { id: 'F2', azimuth: 20 }],
  ...overrides,
});

test('строка дворов показывает активный снимок и последний возврат', () => {
  const [accepted] = yardsSheetRows([yardRow()]);
  assert.equal(accepted.photo_state, 'accepted');
  assert.equal(accepted.photo_id, PHOTO);
  assert.equal(accepted.preview_photo_id, PHOTO);
  assert.equal(accepted.frame, null);
  assert.equal(accepted.reviewed_at, '2026-11-02T10:00:00Z', 'время проверки берётся из активного снимка');

  const [rework] = yardsSheetRows([yardRow({
    photo_id: null, photo_status: null, uploaded_at: null, reviewed_at: null,
    rejected_photo_id: REJECTED, rejected_comment: 'Не тот ракурс', rejected_at: '2026-11-05T10:00:00Z',
  })]);
  assert.equal(rework.photo_state, 'rework');
  assert.equal(rework.photo_id, null, 'решение адресуется только активному снимку');
  assert.equal(rework.preview_photo_id, REJECTED, 'в таблице видно, за что вернули');
  assert.equal(rework.rejected_comment, 'Не тот ракурс');
});

test('у кадра ОДХ есть номер кадра, а «нет тротуара» без снимка не теряется', () => {
  const sources = [
    frameSource(),
    frameSource({ id: 'АВД-1', balance: 'АвД САО', noSidewalk: true, slots: [{ id: 'F3', azimuth: 0 }] }),
  ];
  const photos = new Map([['F1', { id: PHOTO, status: 'accepted', uploaded_at: '2026-11-01T10:00:00Z', reviewed_at: null, review_comment: 'ок' }]]);
  const rows = odhSheetRows(sources, { edits: new Map(), photos, mergePoint });
  assert.equal(rows.length, 3, 'включая кадр без снимка');
  assert.deepEqual(rows.map(row => row.frame), [1, 2, 1]);
  assert.equal(rows[0].photo_state, 'accepted');
  assert.equal(rows[0].review_comment, 'ок');
  assert.equal(rows[1].photo_state, 'empty');
  const flagged = rows[2];
  assert.equal(flagged.district, 'АВД САО', 'кадры АвД идут отдельной строкой района');
  assert.equal(flagged.district_raw, 'Беговой', 'для ссылки на карту остаётся настоящий район');
  assert.equal(flagged.no_sidewalk, true);
  assert.equal(flagged.point_no, 'АВД-1');
});

test('ссылки на превью выдаются один раз и не меняются при повторной синхронизации', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT photo_id FROM sidewalk_sheet_tokens')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO sidewalk_sheet_tokens')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT photo_id, token FROM sidewalk_sheet_tokens')) return { rows: [{ photo_id: PHOTO, token: TOKEN }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const rows = await attachPhotoTokens(pool, 'yards', yardsSheetRows([yardRow()]));
  assert.equal(rows[0].photo_token, TOKEN);
  const insert = calls.find(call => call.sql.includes('INSERT INTO sidewalk_sheet_tokens'));
  assert.deepEqual(insert.params[1], 'yards');
  assert.deepEqual(insert.params[2], [PHOTO]);
  assert.deepEqual(insert.params[3], [POINT], 'ключ объекта — точка или фотослот');

  const again = { query: async sql => (sql.includes('SELECT photo_id FROM sidewalk_sheet_tokens')
    ? { rows: [{ photo_id: PHOTO }], rowCount: 1 }
    : sql.includes('SELECT photo_id, token FROM sidewalk_sheet_tokens')
      ? { rows: [{ photo_id: PHOTO, token: TOKEN }], rowCount: 1 }
      : { rows: [], rowCount: 0 }) };
  const callsAgain = [];
  const second = await attachPhotoTokens({ query: async (sql, params) => { callsAgain.push(sql); return again.query(sql, params); } }, 'yards', yardsSheetRows([yardRow()]));
  assert.equal(second[0].photo_token, TOKEN);
  assert.ok(!callsAgain.some(sql => sql.includes('INSERT INTO sidewalk_sheet_tokens')), 'повторно токен не выдаётся');
});

test('отозванный токен не подменяется новым', async () => {
  const pool = {
    query: async sql => (sql.includes('SELECT photo_id FROM sidewalk_sheet_tokens')
      ? { rows: [{ photo_id: PHOTO }], rowCount: 1 }
      : sql.includes('SELECT photo_id, token FROM sidewalk_sheet_tokens')
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: 0 }),
  };
  const rows = await attachPhotoTokens(pool, 'yards', yardsSheetRows([yardRow()]));
  assert.equal(rows[0].photo_token, null);
});

test('проверка решений: набор, снимок и причина возврата обязательны', () => {
  assert.equal(validateSheetDecisions({ decisions: [] }, 'yards').error, 'Нет решений.');
  assert.equal(validateSheetDecisions({ decisions: [{ client_id: 'c1' }] }, 'nope').error, 'Укажите набор: odh или yards.');
  assert.match(validateSheetDecisions({ decisions: [{ client_id: 'c1', point_id: FRAME, decision: 'verified' }] }, 'odh').error, /photo_id/);
  assert.match(validateSheetDecisions({ decisions: [{ client_id: 'c1', point_id: FRAME, photo_id: PHOTO, decision: 'rework' }] }, 'odh').error, /причину возврата/);
  const ok = validateSheetDecisions({ set: 'odh', decisions: [{ client_id: 'c1', point_id: FRAME, photo_id: PHOTO, decision: 'rework', reason: 'Блики' }] }, 'odh');
  assert.equal(ok.decisions.length, 1);
  assert.equal(ok.decisions[0].reason, 'Блики');
  assert.equal(ok.decisions[0].reviewed_by, 'sheet');
});

const decisionPool = ({ revoked = 1, status = 'accepted', inserted = 1, applied = true, error = null } = {}) => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO sidewalk_sheet_reviews')) return { rowCount: inserted, rows: inserted ? [{ id: 'row' }] : [] };
      if (sql.includes("status = 'rejected'")) return { rowCount: revoked, rows: revoked ? [{ id: PHOTO }] : [] };
      if (sql.includes('UPDATE sidewalk_sheet_reviews r')) return { rows: [], rowCount: status === 'accepted' ? 1 : 0 };
      if (sql.startsWith('SELECT status FROM')) return { rows: status ? [{ status }] : [], rowCount: status ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return {
    calls,
    pool: {
      connect: async () => client,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT applied, error FROM sidewalk_sheet_reviews')) return { rows: [{ applied, error }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    },
  };
};

test('«Вернуть на доработку» отзывает только принятый снимок и пишет журнал', async () => {
  const { pool, calls } = decisionPool();
  const result = await applySheetDecision(pool, 'odh', {
    client_id: 'c1', point_id: FRAME, photo_id: PHOTO, decision: 'rework', reason: 'Не тот ракурс', comment: 'переснять', reviewed_by: 'ivanov', reviewed_at: new Date(),
  }, 'service-user');
  assert.deepEqual(result, { client_id: 'c1', applied: true });
  assert.ok(calls.some(call => call.sql.includes("status = 'accepted'") && call.params[0] === PHOTO && call.params[1] === FRAME));
  assert.ok(calls.some(call => call.sql.includes("status = 'rejected'") && call.params[2] === 'Не тот ракурс · переснять'),
    'район видит причину, затем комментарий');
  assert.ok(calls.some(call => call.sql.includes('audit_log') && call.params.includes('sidewalk_sheet_photo_revoked')));
  assert.ok(calls.some(call => call.sql.includes('UPDATE sidewalk_sheet_reviews SET applied = true')));
});

test('устаревшая строка не трогает новый снимок и показывает причину', async () => {
  const { pool, calls } = decisionPool({ revoked: 0, status: 'pending' });
  const result = await applySheetDecision(pool, 'yards', {
    client_id: 'c2', point_id: POINT, photo_id: PHOTO, decision: 'rework', reason: 'x', comment: '', reviewed_by: 'sheet', reviewed_at: new Date(),
  }, 'service-user');
  assert.equal(result.applied, false);
  assert.equal(result.error, 'photo_not_accepted');
  assert.ok(!calls.some(call => call.sql.includes('audit_log')));
  assert.ok(calls.some(call => call.sql.includes('SET error = $2') && call.params[1] === 'photo_not_accepted'), 'ошибка сохраняется, чтобы не повторяться каждые 10 минут');
});

test('«Проверено» только фиксируется и требует принятый снимок', async () => {
  const { pool, calls } = decisionPool();
  const result = await applySheetDecision(pool, 'yards', {
    client_id: 'c3', point_id: POINT, photo_id: PHOTO, decision: 'verified', reason: null, comment: 'сверено', reviewed_by: 'sheet', reviewed_at: new Date(),
  }, 'service-user');
  assert.equal(result.applied, true);
  assert.ok(!calls.some(call => call.sql.includes("status = 'rejected'")));
  assert.ok(calls.some(call => call.sql.includes('UPDATE sidewalk_sheet_reviews r')
    && call.sql.includes("p.status = 'accepted'")), 'проверка accepted и отметка — один UPDATE');
  assert.ok(!calls.some(call => call.sql.startsWith('SELECT status FROM')), 'отдельного SELECT статуса нет');

  const stale = decisionPool({ status: 'pending' });
  const rejected = await applySheetDecision(stale.pool, 'yards', {
    client_id: 'c4', point_id: POINT, photo_id: PHOTO, decision: 'verified', reason: null, comment: '', reviewed_by: 'sheet', reviewed_at: new Date(),
  }, 'service-user');
  assert.equal(rejected.error, 'photo_not_accepted');
});

test('повторная отправка решения идемпотентна', async () => {
  const { pool, calls } = decisionPool({ inserted: 0, applied: true });
  const result = await applySheetDecision(pool, 'odh', {
    client_id: 'c5', point_id: FRAME, photo_id: PHOTO, decision: 'verified', reason: null, comment: '', reviewed_by: 'sheet', reviewed_at: new Date(),
  }, 'service-user');
  assert.deepEqual(result, { client_id: 'c5', applied: true, duplicate: true });
  assert.ok(!calls.some(call => call.sql.includes("status = 'rejected'")));
});

test('превью по токену открывается без сессии и отдаётся из кэша', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM sidewalk_sheet_tokens')) return { rows: [{ set_name: 'yards', photo_id: PHOTO, object_key: POINT }], rowCount: 1 };
      if (sql.includes('FROM sidewalk_sheet_thumbs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM sidewalk_photo_slot_photos')) return { rows: [{ photo_bytes: jpeg(), photo_mime_type: 'image/jpeg' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const router = createSidewalkSheetRouter({ pool, authenticate: (_q, _s, next) => next() });
  const { handler, index } = run(router, '/photo-thumb/:token');
  const authIndex = router.stack.findIndex(layer => !layer.route && layer.name === 'router');
  assert.ok(authIndex === -1 || index < authIndex, 'превью стоит до проверки сессии');
  const res = response();
  await handler({ params: { token: TOKEN } }, res, (error) => { throw error; });
  assert.equal(res.headers['Cache-Control'], 'public, max-age=86400, immutable');
  assert.equal(res.headers['X-Robots-Tag'], 'noindex');
  assert.equal(res.body.subarray(0, 2).toString('hex'), 'ffd8', 'на выходе JPEG 320 px');
});

test('превью не отдаёт оригинал по неизвестному токену', async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const router = createSidewalkSheetRouter({ pool, authenticate: (_q, _s, next) => next() });
  const { handler } = run(router, '/photo-thumb/:token');
  const res = response();
  await handler({ params: { token: 'nope' } }, res, () => {});
  assert.equal(res.code, 404);
});

test('превью не отдаёт кэш удалённого снимка', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM sidewalk_sheet_tokens')) return { rows: [{ set_name: 'yards', photo_id: PHOTO, object_key: POINT }] };
      if (sql.includes('SELECT status FROM')) return { rows: [] };
      if (sql.includes('FROM sidewalk_sheet_thumbs')) return { rows: [{ photo_bytes: jpeg(), photo_mime_type: 'image/jpeg' }] };
      return { rows: [] };
    },
  };
  const router = createSidewalkSheetRouter({ pool, authenticate: (_q, _s, next) => next() });
  const { handler } = run(router, '/photo-thumb/:token');
  const res = response();
  await handler({ params: { token: TOKEN } }, res, () => {});
  assert.equal(res.code, 404, 'токен живой, но снимка уже нет');
});

test('выгрузка и решения закрыты префектурой, превью — без сессии', async () => {
  const router = createSidewalkSheetRouter({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    authenticate: (req, _res, next) => {
      req.user = { role: req.get('x-role') || 'prefecture_admin', sub: 'service-user' };
      next();
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/sheet', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/sheet`;
  try {
    const district = await fetch(base + '/sheet.json?set=odh', { headers: { 'x-role': 'district_editor' } });
    assert.equal(district.status, 403, 'район не читает книгу префектуры');

    const badSet = await fetch(base + '/sheet.json?set=nope');
    assert.equal(badSet.status, 422, 'набор проверяется до выгрузки');

    const noDecisions = await fetch(base + '/sheet-decisions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ set: 'odh', decisions: [] }),
    });
    assert.equal(noDecisions.status, 422);

    const thumb = await fetch(base + '/photo-thumb/' + 'c'.repeat(32));
    assert.equal(thumb.status, 404, 'неизвестный токен не требует сессии и не отдаёт фото');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
