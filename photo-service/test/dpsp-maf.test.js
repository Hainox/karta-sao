import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createDpspMafRouter } from '../src/tpu-points/dpsp-maf.js';
import { createPhotoServicePointsAdapter } from '../src/tpu-points/photo-service-points-adapter.js';

const POINT = '5e9480d8-b5b6-5a46-9f91-ece0a7a7cf11';
const MAF = '4b209796-bcf5-4f12-9cbe-ce4c9f9342a8';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

// Копия контракта dpsp-maf.js: ответы разводятся по характерным фрагментам SQL.
const poolFor = (overrides = {}) => {
  const calls = [];
  const reply = (sql) => {
    if (sql.includes('SELECT code,label,kind,sort FROM dpsp_maf_types')) {
      return { rows: overrides.types ?? [{ code: 'swings', label: 'Качели', kind: 'dp', sort: 10 }], rowCount: 1 };
    }
    if (sql.includes('SELECT 1 FROM dpsp_maf_types')) return { rows: [{ '?': 1 }], rowCount: 1 };
    if (sql.includes('SELECT 1 FROM playground_photo_points')) return { rows: [{ id: POINT }], rowCount: 1 };
    if (sql.includes('INSERT INTO dpsp_maf_items')) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT id FROM dpsp_maf_items')) return { rows: [{ id: MAF }], rowCount: 1 };
    if (sql.includes('SELECT * FROM (') ) return { rows: overrides.sites ?? [], rowCount: overrides.sites?.length ?? 0 };
    if (sql.includes('dpsp_maf_types t ON t.code=m.type_code') && sql.includes('JOIN playground_photo_points')) {
      return { rows: overrides.maf ?? [], rowCount: overrides.maf?.length ?? 0 };
    }
    if (sql.includes('SELECT p.district,count(*)::int AS sites')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT * FROM ')) return { rows: overrides.sites ?? [], rowCount: 0 };
    if (sql.includes('p.district')) return { rows: overrides.sites ?? [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return reply(sql, params); },
    connect: async () => ({
      query: async (sql, params) => { calls.push({ sql, params }); return reply(sql, params); },
      release() {},
    }),
  };
};

const routerFor = (pool, role = 'prefecture_admin') =>
  createDpspMafRouter({ pool, authenticate: (req, _res, next) => { req.user = { sub: 'service-user', role }; next(); } });

const route = (router, path, method) => {
  const layer = router.stack.find((x) => x.route?.path === path && x.route.methods[method]);
  assert.ok(layer, `маршрут ${method} ${path} зарегистрирован`);
  return layer.route.stack.map((s) => s.handle);
};

const response = () => ({
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
  set() { return this; },
  type() { return this; },
  send() { return this; },
});

test('POST /sites/:id/maf создаёт МАФ и пишет журнал', async () => {
  const pool = poolFor();
  const router = routerFor(pool);
  const [handler] = route(router, '/sites/:id/maf', 'post');
  const res = response();
  await handler({ params: { id: POINT }, body: { type_code: 'swings', quantity: 2, condition: 'repair', comment: 'Под замену' }, user: { sub: 'u1' } }, res, (e) => { throw e; });
  assert.equal(res.code, 201);
  assert.ok(pool.calls.some((c) => c.sql.includes('INSERT INTO dpsp_maf_items')));
  assert.ok(pool.calls.some((c) => c.sql.includes('audit_log') && c.params.includes('dpsp_maf_created')));
  assert.deepEqual(pool.calls.find((c) => c.sql.includes('INSERT INTO dpsp_maf_items')).params, [res.body.id, POINT, 'swings', 2, 'repair', 'Под замену', 'u1']);
});

test('POST /sites/:id/maf отклоняет неверное количество и пустой тип', async () => {
  const pool = poolFor();
  const router = routerFor(pool);
  const [handler] = route(router, '/sites/:id/maf', 'post');
  const bad = response();
  await handler({ params: { id: POINT }, body: { type_code: 'swings', quantity: 5000 }, user: { sub: 'u1' } }, bad, (e) => { throw e; });
  assert.equal(bad.code, 422);
  const empty = response();
  await handler({ params: { id: POINT }, body: { type_code: '' }, user: { sub: 'u1' } }, empty, (e) => { throw e; });
  assert.equal(empty.code, 422);
  assert.ok(!pool.calls.some((c) => c.sql.includes('INSERT INTO dpsp_maf_items')));
});

test('PUT /maf/:id/photo заменяет активный снимок и выдаёт токен', async () => {
  const pool = poolFor();
  const router = routerFor(pool);
  const handler = route(router, '/maf/:id/photo', 'put').at(-1);
  const res = response();
  await handler({ params: { id: MAF }, body: JPEG, get: (name) => (name === 'content-type' ? 'image/jpeg' : 'kachel.jpg'), user: { sub: 'u1' } }, res, (e) => { throw e; });
  assert.equal(res.code, 201);
  assert.match(res.body.thumb_token, /^[0-9a-f]{32}$/);
  assert.ok(pool.calls.some((c) => c.sql.includes("SET status='superseded'")));
  assert.ok(pool.calls.some((c) => c.sql.includes('INSERT INTO dpsp_maf_photos')));
  assert.ok(pool.calls.some((c) => c.sql.includes('UPDATE dpsp_maf_photo_tokens SET revoked_at=now()')));
  assert.ok(pool.calls.some((c) => c.sql.includes('INSERT INTO dpsp_maf_photo_tokens')));
  assert.ok(pool.calls.some((c) => c.sql === 'COMMIT'));
});

test('PUT /maf/:id/photo отклоняет не-изображение', async () => {
  const pool = poolFor();
  const router = routerFor(pool);
  const handler = route(router, '/maf/:id/photo', 'put').at(-1);
  const res = response();
  await handler({ params: { id: MAF }, body: Buffer.from('это не фото'), get: () => 'image/jpeg', user: { sub: 'u1' } }, res, (e) => { throw e; });
  assert.equal(res.code, 422);
  assert.ok(!pool.calls.some((c) => c.sql.includes('INSERT INTO dpsp_maf_photos')));
});

test('POST /sites/:id/check снимает отметку при checked=false', async () => {
  const pool = poolFor();
  const router = routerFor(pool);
  const [handler] = route(router, '/sites/:id/check', 'post');
  const res = response();
  await handler({ params: { id: POINT }, body: { checked: false }, user: { sub: 'u1' } }, res, (e) => { throw e; });
  assert.deepEqual(res.body, { checked: false });
  assert.ok(pool.calls.some((c) => c.sql.includes('DELETE FROM dpsp_site_checks')));
  assert.ok(pool.calls.some((c) => c.sql.includes('audit_log') && c.params.includes('dpsp_site_unchecked')));
});

test('GET /sheet.json отдаёт площадки, МАФ и справочники со слагами', async () => {
  const pool = poolFor({
    sites: [{ point_id: POINT, district: 'Хорошевский', kind: 'dp', address: 'Острякова ул. 11' }],
    maf: [{ id: MAF, point_id: POINT, district: 'Хорошевский', type_code: 'swings' }],
    types: [{ code: 'swings', label: 'Качели', kind: 'dp', sort: 10 }, { code: 'other', label: 'Прочее', kind: null, sort: 900 }],
  });
  const router = routerFor(pool);
  const [handler] = route(router, '/sheet.json', 'get');
  const res = response();
  await handler({ query: {}, user: { sub: 'u1' } }, res, (e) => { throw e; });
  assert.equal(res.body.sites[0].district_slug, 'horoshevskiy');
  assert.equal(res.body.dictionaries.types[0].code, 'swings');
  assert.equal(res.body.dictionaries.districts.length, 16);
  assert.ok(res.body.dictionaries.types.some((t) => t.kind === null), 'универсальные типы присутствуют');
});

test('GET /sites фильтрует по статусу оцифровки', async () => {
  const pool = poolFor({ sites: [] });
  const router = routerFor(pool);
  const [handler] = route(router, '/sites', 'get');
  const res = response();
  await handler({ query: { status: 'unchecked', district: 'Коптево' }, user: { sub: 'u1' } }, res, (e) => { throw e; });
  const sql = pool.calls.find((c) => c.sql.includes('SELECT * FROM (')).sql;
  assert.ok(sql.includes('s.checked_at IS NULL'));
  assert.ok(sql.includes('s.district=$1'));
  assert.deepEqual(pool.calls.find((c) => c.sql.includes('SELECT * FROM (')).params, ['Коптево']);
});

test('адаптер монтирует кабинет по /object-photo-points/dpsp и пускает только префектуру', async () => {
  const app = express();
  app.use('/photo-api', createPhotoServicePointsAdapter({
    pool: poolFor(),
    currentUser: async (req) => ({ id: 'u1', role: req.headers['x-test-role'] || 'prefecture_admin' }),
    boundary: {},
  }));
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const ok = await fetch(`http://127.0.0.1:${port}/photo-api/object-photo-points/dpsp/dictionaries`, { headers: { Authorization: 'Bearer x' } });
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.ok(data.types.length);
    const denied = await fetch(`http://127.0.0.1:${port}/photo-api/object-photo-points/dpsp/summary`, { headers: { Authorization: 'Bearer x', 'x-test-role': 'district_editor' } });
    assert.equal(denied.status, 403);
  } finally {
    server.close();
  }
});
