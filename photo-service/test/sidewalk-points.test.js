import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSidewalkPointsRouter, validateSidewalkPatch } from '../src/tpu-points/sidewalk-points.js';
import { sidewalkRowsFromLayer } from '../scripts/import-sidewalk-photo-points.js';

const boundary = JSON.parse(readFileSync(new URL('../src/tpu-points/sao_boundary_wgs84.geojson', import.meta.url), 'utf8'));
const ID = '5e9480d8-b5b6-5a46-9f91-ece0a7a7cf11';
const INSIDE = { longitude: 37.5263, latitude: 55.8942 };

function setup(found = true) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE')) return { rows: found ? [{ id: ID, point_no: 'Т7.001' }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: ID }] }; } };
  const router = createSidewalkPointsRouter({ pool, authenticate: (_q, _s, n) => n(), boundary });
  const handler = (path, method) => router.stack.find((x) => x.route?.path === path && x.route.methods[method]).route.stack.at(-1).handle;
  return { calls, handler, router };
}

function res() {
  return { code: 200, status(n) { this.code = n; return this; }, json(x) { this.body = x; return this; }, set() { return this; }, end() { return this; } };
}
const req = (body, extra = {}) => ({ body, params: { id: ID }, query: {}, user: { role: 'prefecture_admin', sub: 'u1' }, ...extra });

test('правка: только координаты и направление', () => {
  assert.ok(validateSidewalkPatch({ label: 'x' }, boundary).error);
  assert.ok(validateSidewalkPatch({}, boundary).error);
  assert.ok(validateSidewalkPatch({ longitude: 37.5 }, boundary).error, 'одна координата без второй');
  assert.ok(validateSidewalkPatch({ longitude: 30, latitude: 50 }, boundary).error, 'точка вне САО');
  assert.deepEqual(validateSidewalkPatch({ heading: 361.4 }, boundary).value, { heading: 1 });
  assert.deepEqual(validateSidewalkPatch({ heading: -90 }, boundary).value, { heading: 270 });
  assert.deepEqual(validateSidewalkPatch(INSIDE, boundary).value, INSIDE);
});

test('перенос пишет точку и запись в журнал в одной транзакции', async () => {
  const x = setup();
  const r = res();
  await x.handler('/:id', 'patch')(req({ ...INSIDE, heading: 90 }), r, (e) => { throw e; });
  assert.equal(r.code, 200);
  const sqls = x.calls.map((c) => c.sql);
  assert.equal(sqls[0], 'BEGIN');
  assert.match(sqls[1], /UPDATE sidewalk_photo_points SET longitude = \$3, latitude = \$4, heading = \$5/);
  assert.deepEqual(x.calls[1].params, [ID, 'u1', INSIDE.longitude, INSIDE.latitude, 90]);
  assert.match(sqls[2], /INSERT INTO audit_log/);
  assert.equal(sqls[3], 'COMMIT');
});

test('удаление помечает точку, а не стирает её', async () => {
  const x = setup();
  const r = res();
  await x.handler('/:id', 'delete')(req(undefined), r, (e) => { throw e; });
  assert.equal(r.code, 204);
  assert.match(x.calls[1].sql, /SET retired_at = now\(\)/);
  assert.ok(!x.calls.some((c) => /DELETE FROM/.test(c.sql)));
});

test('правка удалённой или чужой точки — 404 без записи в журнал', async () => {
  const x = setup(false);
  const r = res();
  await x.handler('/:id', 'patch')(req({ heading: 10 }), r, (e) => { throw e; });
  assert.equal(r.code, 404);
  assert.ok(!x.calls.some((c) => /audit_log/.test(c.sql)));
});

test('список требует район САО', async () => {
  const x = setup();
  const r = res();
  await x.handler('/', 'get')(req(undefined, { query: { district: 'Нет такого' } }), r, (e) => { throw e; });
  assert.equal(r.code, 400);
});

test('проверяющий не допускается, район — только к фото своей точки', () => {
  const x = setup();
  const roleGuard = x.router.stack.filter((layer) => !layer.route)[1].handle;
  const r = res();
  roleGuard({ user: { role: 'reviewer' } }, r, () => assert.fail('пропустил проверяющего'));
  assert.equal(r.code, 403);
  let passed = false;
  roleGuard({ user: { role: 'district_editor', district: 'Сокол' } }, res(), () => { passed = true; });
  assert.ok(passed, 'район проходит к фото своих точек');
  // Пока префектура согласовывает точки, список, правка, удаление и приёмка — только у неё.
  for (const [path, method] of [['/', 'get'], ['/:id', 'patch'], ['/:id', 'delete'], ['/:id/review', 'post'], ['/:id/photo', 'delete']]) {
    const guard = x.router.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;
    const gr = res();
    guard({ user: { role: 'district_editor', district: 'Сокол' } }, gr, () => assert.fail(`район прошёл ${method} ${path}`));
    assert.equal(gr.code, 403);
  }
});

test('импорт читает опубликованный слой района целиком', () => {
  const data = JSON.parse(readFileSync(new URL('../../districts/layers/dmitrovskiy/sidewalk_shoot.geojson', import.meta.url), 'utf8'));
  const problems = [];
  const rows = sidewalkRowsFromLayer(data, problems);
  assert.equal(problems.length, 0);
  assert.equal(rows.length, data.features.length);
  assert.ok(rows.every((row) => row.district === 'Дмитровский' && row.heading >= 0 && row.heading < 360));
  assert.equal(new Set(rows.map((row) => row.point_no)).size, rows.length);
});
