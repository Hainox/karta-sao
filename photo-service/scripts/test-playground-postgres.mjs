import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import express from 'express';
import pg from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { createPlaygroundPhotoRouter } from '../src/tpu-points/playground-photo.js';

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
  console.log('PASS: PostgreSQL migrations, import, slots, duplicate prevention and review');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
}
