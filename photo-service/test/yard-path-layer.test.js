import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import ExcelJS from 'exceljs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createYardPathLayerRouter } from '../src/tpu-points/yard-path-layer.js';

test('catalog and district access, one frame per point and restart', async () => {
  const point = {id:'Y2-X', district:'Аэропорт', balance:'Аэропорт', street:'1', taskId:'1:1', coordinates:[37.51,55.81],
    slots:Array.from({length:6},(_,i)=>({id:'Y2-X-'+(i+1),azimuth:i*60}))};
  const points = [point,{...point,id:'Y2-Y',district:'Коптево',balance:'Коптево',slots:[{id:'Y2-Y-1',azimuth:0}]}];
  const dir = await mkdtemp(join(tmpdir(), 'yard-path-test-'));
  const catalogPath = join(dir,'catalog.json');
  await writeFile(catalogPath,JSON.stringify({version:1,points}));
  const editsPath = join(dir, 'edits.json');
  const authenticate = (req,res,next) => {
    const role=req.get('x-role');
    if (!role) return res.sendStatus(401);
    req.user={role,district:decodeURIComponent(req.get('x-district') || '')};
    next();
  };
  const makeRouter=()=>createYardPathLayerRouter({catalogPath,editsPath,authenticate,pool:{async query(){return {rows:[]};}}});
  let router=makeRouter();
  const app=express();
  app.use(express.json());
  app.use((req,res,next)=>router(req,res,next));
  const srv=app.listen(0);
  await new Promise(resolve=>srv.once('listening',resolve));
  const base='http://127.0.0.1:'+srv.address().port;
  const get=(path,role,district=point.district)=>fetch(base+path,{headers:role?{'x-role':role,'x-district':encodeURIComponent(district)}:{}});
  const patch=(body,role='prefecture_admin',district=point.district)=>fetch(base+'/'+point.id,{
    method:'PATCH',headers:{'content-type':'application/json','x-role':role,'x-district':encodeURIComponent(district)},body:JSON.stringify(body)});
  const post=(path,body,role='prefecture_admin')=>fetch(base+path,{
    method:'POST',headers:{'content-type':'application/json','x-role':role,'x-district':encodeURIComponent(point.district)},body:JSON.stringify(body)});
  const remove=(path,role='prefecture_admin')=>fetch(base+path,{
    method:'DELETE',headers:{'x-role':role,'x-district':encodeURIComponent(point.district)}});
  const overview='/?district='+encodeURIComponent(point.district);
  try {
    assert.equal((await get(overview)).status,401);
    assert.equal((await get(overview,'district_editor')).status,403);
    const own=await (await get('/district','district_editor')).json();
    assert.ok(own.points.length>0);
    assert.ok(own.points.every(p=>p.district===point.district));
    assert.ok(own.points.every(p=>p.slots.length===1&&p.singleFrame===true));
    const dpspOwn = await (await get('/district','dpsp_district_editor')).json();
    assert.ok(dpspOwn.points.length > 0);
    assert.ok(dpspOwn.points.every(p => p.district === point.district));
    assert.equal((await get('/district/report.xlsx', 'dpsp_district_editor')).status, 403);
    const report = await get('/district/report.xlsx', 'prefecture_admin');
    assert.equal(report.status, 200);
    assert.match(report.headers.get('content-disposition'), /Svod_foto_dvorovye_dorozhki_SAO_/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await report.arrayBuffer());
    assert.equal(workbook.getWorksheet('Свод по районам').getCell('A1').text, 'Оцифровка дворовых дорожек ДТС');
    const dpspOther = await (await get('/district','dpsp_district_editor','Коптево')).json();
    assert.ok(dpspOther.points.every(p => p.district === 'Коптево'));
    assert.equal((await patch({coordinates:[37.52,55.82]},'dpsp_district_editor')).status,403);
    const different=points.find(p=>p.district!==point.district).district;
    assert.equal((await patch({noSidewalk:true},'district_editor',different)).status,403);
    assert.equal((await patch({slotId:point.slots[0].id,azimuth:42},'district_editor')).status,403);
    assert.equal((await patch({slotId:'fake',azimuth:42})).status,404);
    assert.equal((await patch({slotId:point.slots[4].id,azimuth:42})).status,404);
    const update=await patch({slotId:point.slots[0].id,azimuth:42});
    assert.equal(update.status,200);
    const response=await update.json();
    assert.equal(response.point.slots.length,1);
    assert.equal(response.point.slots[0].id,point.slots[0].id);
    assert.equal(response.point.slots[0].azimuth,42);
    assert.equal(response.point.singleFrame,true);
    assert.equal((await patch({coordinates:[37.51,55.81]})).status,200);
    assert.equal((await patch({noSidewalk:true},'district_editor')).status,200);
    const createdResponse=await post('/',{district:point.district,coordinates:[37.52,55.82],azimuth:135});
    assert.equal(createdResponse.status,201);
    const createdPoint=(await createdResponse.json()).point;
    assert.equal(createdPoint.slots.length,1);
    assert.equal(createdPoint.slots[0].azimuth,135);
    assert.equal((await post('/',{district:point.district,coordinates:[38,56],azimuth:90})).status,400);
    assert.equal((await post('/'+point.id+'/slots',{azimuth:240},'district_editor')).status,403);
    assert.equal((await post('/'+createdPoint.id+'/slots',{azimuth:240})).status,409);
    assert.equal((await remove('/'+createdPoint.id+'/slots/'+createdPoint.slots[0].id,'district_editor')).status,403);
    assert.equal((await remove('/'+createdPoint.id+'/slots/'+createdPoint.slots[0].id)).status,409);
    const source=JSON.parse(await readFile(catalogPath,'utf8'));
    assert.equal(source.points.find(item=>item.id===point.id).slots.length,6);
    assert.equal((await remove('/'+createdPoint.id,'district_editor')).status,403);
    assert.equal((await remove('/'+createdPoint.id)).status,200);
    router=makeRouter();
    const active=(await (await get(overview,'prefecture_admin')).json()).points;
    assert.ok(!active.some(p=>p.id===createdPoint.id));
    const saved=(await (await get(overview,'prefecture_admin')).json()).points.find(p=>p.id===point.id);
    assert.equal(saved.slots.length,1);
    assert.equal(saved.slots[0].azimuth,42);
    assert.deepEqual(saved.coordinates,[37.51,55.81]);
    assert.equal(saved.noSidewalk,true);
  } finally { await new Promise(resolve=>srv.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});

test('single-frame catalog keeps one direction on catalog and manually created points', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dts-single-'));
  const catalogPath = join(dir, 'catalog.json');
  const point = { id: 'test-dts', district: 'Аэропорт', balance: 'Аэропорт', coordinates: [37.51,55.81],
    slots: [{ id: 'test-frame', azimuth: 0 }] };
  await writeFile(catalogPath, JSON.stringify({version: 1, singleFrame: true, points: [point]}));
  const app = express();
  app.use(express.json(), createYardPathLayerRouter({ catalogPath, editsPath: join(dir,'edits.json'),
    authenticate(req, _res, next) { req.user = {role: 'prefecture_admin'}; next(); },
    pool: {query: async () => ({rows: []})} }));
  const server = app.listen(0,'127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (path, body) => fetch(base + path, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
    const created = (await (await post('/', {...point, azimuth:90})).json()).point;
    const active = await (await fetch(base+'/?district='+encodeURIComponent(point.district))).json();
    assert.equal(active.points.length,2);
    for (const p of active.points) {
      assert.equal(p.singleFrame,true);
      assert.equal((await post('/'+p.id+'/slots',{azimuth:45})).status,409);
      assert.equal((await fetch(base+'/'+p.id+'/slots/'+p.slots[0].id,{method:'DELETE'})).status,409);
    }
    assert.equal((await fetch(base+'/'+created.id,{method:'DELETE'})).status,200);
  } finally { await new Promise(resolve=>server.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});

test('production catalog: all points and slots, if privately provisioned', async (t) => {
  let catalog;
  try { catalog=JSON.parse(await readFile(new URL('../assets/yard-path-points.json', import.meta.url),'utf8')); }
  catch(error) { if(error.code==='ENOENT') return t.skip('private catalog not provisioned'); throw error; }
  const {points}=catalog;
  const frames=points.flatMap(p=>p.slots);
  if (catalog.singleFrame) {
    assert.ok(points.every(p=>p.slots.length===1));
  } else {
    assert.equal(points.length,6563);
    assert.equal(frames.length,16572);
  }
  assert.equal(new Set(points.map(p=>p.id)).size,points.length);
  assert.equal(new Set(frames.map(f=>f.id)).size,frames.length);
  assert.equal(new Set(points.map(p=>p.district)).size,16);
  assert.ok(frames.every(f=>Number.isFinite(f.azimuth)&&f.azimuth>=0&&f.azimuth<360));
});
