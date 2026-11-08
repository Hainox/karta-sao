import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { createPlaygroundPhotoRouter } from '../src/tpu-points/playground-photo.js';

const ID = '5e9480d8-b5b6-5a46-9f91-ece0a7a7cf11';
const TOKEN = 'a'.repeat(32);

const jpeg = () => {
  const canvas = createCanvas(800, 600);
  const context = canvas.getContext('2d');
  context.fillStyle = '#2a6';
  context.fillRect(0, 0, 800, 600);
  return canvas.toBuffer('image/jpeg', 85);
};

const harness = (photoBytes) => {
  const queries = [];
  const pool = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('FROM photo_public_tokens')) return { rows: [{ photo_id: ID, photo_bytes: photoBytes }] };
      if (sql.includes('FROM playground_photo_thumbs')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };
  const router = createPlaygroundPhotoRouter({ pool, authenticate: (_q, _s, next) => next() });
  const index = router.stack.findIndex((layer) => layer.route?.path === '/photo-thumb/:token');
  const authIndex = router.stack.findIndex((layer) => !layer.route && layer.name === 'router');
  return { router, queries, index, authIndex };
};

const response = () => ({
  headers: {},
  set(name, value) { this.headers[name] = value; return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
  type() { return this; },
  send(body) { this.body = body; return this; },
});

test('превью по токену отдаётся без сессии и кэшируется на сутки', async () => {
  const { router, index, authIndex } = harness(jpeg());
  assert.ok(index >= 0, 'маршрут превью зарегистрирован');
  assert.ok(authIndex === -1 || index < authIndex, 'маршрут превью стоит до проверки сессии');
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler({ params: { token: TOKEN } }, res, (error) => { throw error; });
  assert.equal(res.headers['Cache-Control'], 'public, max-age=86400, immutable');
  assert.equal(res.headers['X-Robots-Tag'], 'noindex');
  assert.equal(res.body.subarray(0, 2).toString('hex'), 'ffd8', 'на выходе JPEG');
});

test('неизвестный токен не отдаёт фото', async () => {
  const { router, index } = harness(jpeg());
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler({ params: { token: 'not-a-token' } }, res, () => {});
  assert.equal(res.code, 404);
  assert.equal(res.body?.error, 'Фото не найдено.');
});

test('второй запрос берёт превью из таблицы и не пережимает', async () => {
  const queries = [];
  const pool = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('FROM photo_public_tokens')) return { rows: [{ photo_id: ID, photo_bytes: jpeg() }] };
      if (sql.includes('FROM playground_photo_thumbs')) return { rows: [{ photo_bytes: jpeg(), photo_mime_type: 'image/jpeg' }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const router = createPlaygroundPhotoRouter({ pool, authenticate: (_q, _s, next) => next() });
  const index = router.stack.findIndex((layer) => layer.route?.path === '/photo-thumb/:token');
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler({ params: { token: TOKEN } }, res, (error) => { throw error; });
  assert.ok(queries.some((sql) => sql.includes('FROM playground_photo_thumbs')));
  assert.ok(!queries.some((sql) => sql.includes('INSERT INTO playground_photo_thumbs')), 'повторно не вставляет');
});

test('снимок Север ЖКХ отдаётся по токену без сессии', async () => {
  const pool = {
    query: async (sql) => (sql.includes('FROM sever_photo_thumbs')
      ? { rows: [{ photo_bytes: jpeg() }] }
      : { rows: [], rowCount: 1 }),
  };
  const router = createPlaygroundPhotoRouter({ pool, authenticate: (_q, _s, next) => next() });
  const index = router.stack.findIndex((layer) => layer.route?.path === '/sever-thumb/:token');
  assert.ok(index >= 0, 'маршрут снимка СЖКХ зарегистрирован');
  const handler = router.stack[index].route.stack.at(-1).handle;
  const res = response();
  await handler({ params: { token: TOKEN } }, res, (error) => { throw error; });
  assert.equal(res.headers['Cache-Control'], 'public, max-age=86400, immutable');
  assert.equal(res.body.subarray(0, 2).toString('hex'), 'ffd8');
});
