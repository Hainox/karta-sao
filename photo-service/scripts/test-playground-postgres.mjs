import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import express from 'express';
import pg from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { createPlaygroundPhotoRouter } from '../src/tpu-points/playground-photo.js';
import { createSidewalkPointsRouter } from '../src/tpu-points/sidewalk-points.js';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PLAYGROUND_DISPOSABLE_DB, 'yes', 'Disposable database required');
const pool = new pg.Pool(photoServiceDatabaseConfig(process.env));
let server;
try {
  const run = (file, args = []) => execFileSync(process.execPath, [file, ...args], { encoding: 'utf8' });
  run('scripts/migrate.js');
  const first = JSON.parse(run('scripts/import-playground-photo-points.js', ['--apply']));
  assert.deepEqual([first.points, first.children, first.sport, first.inserted, first.slotsCreated], [3042, 2218, 824, 3042, 3042]);
  const second = JSON.parse(run('scripts/import-playground-photo-points.js', ['--apply']));
  assert.deepEqual([second.inserted, second.skipped, second.slotsCreated], [0, 3042, 0]);
  const totals = await pool.query('SELECT (SELECT count(*)::int FROM playground_photo_points) AS points, (SELECT count(*)::int FROM playground_photo_slots) AS slots');
  assert.deepEqual(totals.rows[0], { points: 3042, slots: 3042 });
  await pool.query("INSERT INTO users (id,email,display_name,role,district,password_hash) VALUES ('test-district','d@example.invalid','test','district_editor','Аэропорт','test'),('test-admin','a@example.invalid','test','prefecture_admin',NULL,'test')");
  const app = express();
  app.use(express.json());
  const authenticate = (req, res, next) => {
    if (req.get('x-test-role') === 'admin') req.user = { sub:'test-admin',role:'prefecture_admin' };
    else if (req.get('x-test-role') === 'district') req.user = { sub:'test-district',role:'district_editor',district:'Аэропорт' };
    else return res.status(401).end();
    next();
  };
  app.use('/playgrounds', createPlaygroundPhotoRouter({ pool, authenticate }));
  const saoBoundary = JSON.parse(readFileSync(new URL('../src/tpu-points/sao_boundary_wgs84.geojson', import.meta.url), 'utf8'));
  app.use('/sidewalks', createSidewalkPointsRouter({ pool, authenticate, boundary: saoBoundary }));
  app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: 'test server error' }); });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/playgrounds';
  const get = await fetch(base + '/public?district=' + encodeURIComponent('Аэропорт'));
  assert.equal(get.status, 200);
  const point = (await get.json()).points[0];
  assert.ok(point && point.photo_state === 'empty');
  const url = base + '/' + point.id + '/photo';
  const png = Buffer.from([137,80,78,71,13,10,26,10,1]);
  const upload = () => fetch(url, { method:'PUT',headers:{'x-test-role':'district','content-type':'image/png'},body:png });
  assert.equal((await upload()).status, 201);
  assert.equal((await upload()).status, 409);
  const photo = await fetch(url, {headers:{'x-test-role':'district'}});
  assert.equal(photo.status, 200);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png);
  const review = (decision, comment) => fetch(base + '/' + point.id + '/review', {method:'POST',headers:{'x-test-role':'admin','content-type':'application/json'},body:JSON.stringify({decision,comment})});
  assert.equal((await review('rejected', 'Переснять')).status, 200);
  assert.equal((await upload()).status, 201);
  assert.equal((await review('accepted', '')).status, 200);
  assert.equal((await upload()).status, 409);
  const active = await pool.query("SELECT status FROM playground_photo_slot_photos WHERE point_id=$1 ORDER BY uploaded_at", [point.id]);
  assert.deepEqual(active.rows.map(row => row.status), ['rejected','accepted']);

  // Кабинет приёмки, режим «ДП и СП»: очередь и свод считают все площадки по реальному SQL.
  const returned = (await (await fetch(base + '/public?district=' + encodeURIComponent('Аэропорт'))).json()).points[1];
  assert.equal((await fetch(base + '/' + returned.id + '/photo', { method:'PUT',headers:{'x-test-role':'district','content-type':'image/png'},body:png })).status, 201);
  assert.equal((await fetch(base + '/' + returned.id + '/review', {method:'POST',headers:{'x-test-role':'admin','content-type':'application/json'},body:JSON.stringify({decision:'rejected',comment:'Площадка не в кадре'})})).status, 200);
  assert.equal((await fetch(base + '/queue', {headers:{'x-test-role':'district'}})).status, 403);
  const queue = await (await fetch(base + '/queue', {headers:{'x-test-role':'admin'}})).json();
  assert.deepEqual(queue.counts, { total: 3042, empty: 3040, pending: 0, accepted: 1, rework: 1 });
  assert.equal(queue.rework[0].point_id, returned.id);
  assert.equal(queue.rework[0].rejected_comment, 'Площадка не в кадре');
  assert.ok(['dp', 'sp'].includes(queue.rework[0].kind));
  const report = await fetch(base + '/report.xlsx', {headers:{'x-test-role':'admin'}});
  assert.equal(report.status, 200);
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await report.arrayBuffer()));
  const totalRow = book.getWorksheet('Свод по районам').getRow(5 + 16);
  assert.deepEqual(totalRow.values.slice(1, 7), ['Итого по САО', 3042, 1, 3040, 0, 1]);
  // Миграции перезапускаются при каждой выкладке: районная точка с тремя
  // снимками (два возврата на доработку) не должна ронять повторный прогон.
  const districtPoint = '11111111-1111-4111-8111-111111111111';
  await pool.query(`INSERT INTO object_photo_points (id,dataset_id,object_key,object_type,district,longitude,latitude,label,created_by,updated_by)
    VALUES ($1,'sao_district_photo_points','district:sokol','district','Сокол',37.5,55.8,'p','test-admin','test-admin')`, [districtPoint]);
  for (const [name, status, age] of [['a.png', 'rejected', 3], ['b.png', 'rejected', 2], ['c.png', 'accepted', 1]]) {
    await pool.query(`INSERT INTO object_photo_point_photos (id,point_id,photo_bytes,photo_mime_type,photo_filename,photo_size,uploaded_by,uploaded_at,assignment_version,assignment_longitude,assignment_latitude,status,dataset_id)
      VALUES (gen_random_uuid(),$1,'x','image/png',$2,1,'test-admin',now()-make_interval(days=>$4),1,37.5,55.8,$3,'sao_district_photo_points')`, [districtPoint, name, status, age]);
  }
  run('scripts/migrate.js');
  const history = await pool.query('SELECT status FROM object_photo_point_photos WHERE point_id=$1 ORDER BY uploaded_at', [districtPoint]);
  assert.deepEqual(history.rows.map((row) => row.status), ['rejected', 'rejected', 'accepted']);
  // Точки съёмки тротуаров: импорт слоёв атласа и слот фото «район загружает — префектура принимает».
  const sidewalkImport = run('scripts/import-sidewalk-photo-points.js', ['--source=../districts/layers', '--apply']);
  assert.match(sidewalkImport, /новых: 5710; с ошибками: 0/);
  assert.match(run('scripts/import-sidewalk-photo-points.js', ['--source=../districts/layers']), /новых: 0;/);
  const sw = 'http://127.0.0.1:' + server.address().port + '/sidewalks';
  const swCall = (path, role, options = {}) => fetch(sw + path, { ...options, headers: { 'x-test-role': role, 'content-type': 'application/json', ...(options.headers || {}) } });
  assert.equal((await swCall('?district=' + encodeURIComponent('Аэропорт'), 'district')).status, 403);
  const swList = await (await swCall('?district=' + encodeURIComponent('Аэропорт'), 'admin')).json();
  assert.equal(swList.points.length, 386);
  const own = swList.points[0];
  assert.equal(own.photo_state, 'empty');
  const foreign = (await (await swCall('?district=' + encodeURIComponent('Сокол'), 'admin')).json()).points[0];
  const swUpload = (point, role) => swCall('/' + point.id + '/photo', role, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal((await swUpload(foreign, 'district')).status, 404, 'район не загружает фото чужого района');
  const firstSw = await swUpload(own, 'district');
  assert.equal(firstSw.status, 201);
  assert.equal((await firstSw.json()).status, 'pending');
  assert.equal((await swUpload(own, 'district')).status, 409);
  assert.equal((await swCall('/' + own.id + '/review', 'district', { method: 'POST', body: JSON.stringify({ decision: 'accepted' }) })).status, 403);
  assert.equal((await swCall('/' + own.id + '/review', 'admin', { method: 'POST', body: JSON.stringify({ decision: 'rejected', comment: '' }) })).status, 422);
  assert.equal((await swCall('/' + own.id + '/review', 'admin', { method: 'POST', body: JSON.stringify({ decision: 'rejected', comment: 'Тротуар не в кадре' }) })).status, 200);
  const rework = await (await swCall('/' + own.id + '/slot', 'district')).json();
  assert.equal(rework.active, null);
  assert.equal(rework.rejected.review_comment, 'Тротуар не в кадре');
  assert.equal((await swUpload(own, 'district')).status, 201);
  assert.equal((await swCall('/' + own.id + '/review', 'admin', { method: 'POST', body: JSON.stringify({ decision: 'accepted' }) })).status, 200);
  const swPhoto = await swCall('/' + own.id + '/photo', 'district');
  assert.equal(swPhoto.status, 200);
  assert.deepEqual(Buffer.from(await swPhoto.arrayBuffer()), png);
  const afterAccept = (await (await swCall('?district=' + encodeURIComponent('Аэропорт'), 'admin')).json()).points.find((p) => p.id === own.id);
  assert.equal(afterAccept.photo_state, 'accepted');
  assert.equal((await swCall('/' + own.id + '/photo', 'admin', { method: 'DELETE' })).status, 204);
  assert.equal((await swCall('/' + own.id + '/slot', 'admin').then((r) => r.json())).active, null);
  const adminSw = await swUpload(own, 'admin');
  assert.equal((await adminSw.json()).status, 'accepted', 'снимок префектуры сразу принят');
  const swHistory = await pool.query('SELECT status FROM sidewalk_photo_slot_photos WHERE point_id=$1 ORDER BY uploaded_at', [own.id]);
  assert.deepEqual(swHistory.rows.map((row) => row.status), ['rejected', 'superseded', 'accepted']);
  // Новая расстановка (--replace): точка с фото остаётся на месте, черновики без правок обновляются.
  const before = (await pool.query('SELECT longitude, latitude, heading FROM sidewalk_photo_points WHERE id=$1', [own.id])).rows[0];
  await pool.query("UPDATE sidewalk_photo_points SET heading = (heading + 90) % 360 WHERE id <> $1 AND updated_by IS NULL", [own.id]);
  const replaced = run('scripts/import-sidewalk-photo-points.js', ['--source=../districts/layers', '--replace', '--apply']);
  assert.match(replaced, /обновлено: 5709; снято: 0/);
  assert.deepEqual((await pool.query('SELECT longitude, latitude, heading FROM sidewalk_photo_points WHERE id=$1', [own.id])).rows[0], before);
  const drift = await pool.query("SELECT count(*)::int AS n FROM sidewalk_photo_points WHERE id <> $1 AND retired_at IS NULL", [own.id]);
  assert.equal(drift.rows[0].n, 5709);
  console.log('PASS: PostgreSQL migrations, import, slots, duplicate prevention, review, review queue and summary, sidewalk photo slots, sidewalk replace');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
}
