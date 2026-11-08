import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaygroundPhotoRouter } from '../src/tpu-points/playground-photo.js';

const POINT = '5e9480d8-b5b6-5a46-9f91-ece0a7a7cf11';
const PHOTO = '4b209796-bcf5-4f12-9cbe-ce4c9f9342a8';

const harness = ({ updateCount = 1, insertCount = 1 } = {}) => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('UPDATE playground_photo_slot_photos')) {
        return { rowCount: updateCount, rows: updateCount ? [{ id: PHOTO }] : [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: insertCount, rows: insertCount ? [{ id: 'r' }] : [] };
    },
  };
  const router = createPlaygroundPhotoRouter({ pool, authenticate: (_q, _s, next) => next() });
  const index = router.stack.findIndex((layer) => layer.route?.path === '/sheet-decisions');
  return { router, calls, index };
};

const response = () => ({
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});

const request = (decisions) => ({
  body: { decisions },
  user: { role: 'prefecture_admin', sub: 'service-user' },
});

test('возврат отзывает принятый снимок и пишет журнал', async () => {
  const { router, calls, index } = harness();
  assert.ok(index >= 0, 'маршрут решений зарегистрирован');
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler(request([{
    client_id: 'c1', point_id: POINT, photo_id: PHOTO, decision: 'rework',
    reason: 'Не тот ракурс', comment: 'Нужен общий план', reviewed_by: 'ivanov@example.ru',
  }]), res, (error) => { throw error; });
  assert.equal(res.body.applied, 1);
  assert.equal(res.body.results[0].applied, true);
  assert.ok(calls.some((c) => c.sql.includes('UPDATE playground_photo_slot_photos')));
  assert.ok(calls.some((c) => c.sql.includes('audit_log') && c.params.includes('playground_photo_revoked')));
  assert.ok(calls.some((c) => c.sql === 'COMMIT'));
});

test('устаревшая строка не отзывает новый снимок', async () => {
  const { router, calls, index } = harness({ updateCount: 0 });
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler(request([{
    client_id: 'c2', point_id: POINT, photo_id: PHOTO, decision: 'rework', comment: 'x',
  }]), res, (error) => { throw error; });
  assert.equal(res.body.results[0].applied, false);
  assert.equal(res.body.results[0].error, 'photo_not_accepted');
  assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
  assert.ok(!calls.some((c) => c.sql.includes('audit_log') && c.params.includes('playground_photo_revoked')));
});

test('приёмка только фиксируется и не трогает снимок', async () => {
  const { router, calls, index } = harness();
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler(request([{
    client_id: 'c3', point_id: POINT, photo_id: PHOTO, decision: 'accepted_crosscheck',
  }]), res, (error) => { throw error; });
  assert.equal(res.body.applied, 1);
  assert.ok(!calls.some((c) => c.sql.includes('UPDATE playground_photo_slot_photos')));
});

test('повторная отправка того же решения идемпотентна', async () => {
  const { router, index } = harness({ insertCount: 0 });
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler(request([{
    client_id: 'c4', point_id: POINT, photo_id: PHOTO, decision: 'accepted_crosscheck',
  }]), res, (error) => { throw error; });
  assert.equal(res.body.results[0].applied, true);
  assert.equal(res.body.results[0].duplicate, true);
});

test('возврат без photo_id отклоняется', async () => {
  const { router, index } = harness();
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler(request([{
    client_id: 'c5', point_id: POINT, decision: 'rework',
  }]), res, (error) => { throw error; });
  assert.equal(res.body.results[0].error, 'photo_required');
});
