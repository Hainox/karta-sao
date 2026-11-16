import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createYardPathLayerRouter } from '../src/tpu-points/yard-path-layer.js';

test('catalog and district access, six-frame editing and restart', async () => {
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
  const overview='/?district='+encodeURIComponent(point.district);
  try {
    assert.equal((await get(overview)).status,401);
    assert.equal((await get(overview,'district_editor')).status,403);
    const own=await (await get('/district','district_editor')).json();
    assert.ok(own.points.length>0);
    assert.ok(own.points.every(p=>p.district===point.district));
    const different=points.find(p=>p.district!==point.district).district;
    assert.equal((await patch({noSidewalk:true},'district_editor',different)).status,403);
    assert.equal((await patch({slotId:point.slots[4].id,azimuth:42},'district_editor')).status,403);
    assert.equal((await patch({slotId:'fake',azimuth:42})).status,404);
    const update=await patch({slotId:point.slots[4].id,azimuth:42});
    assert.equal(update.status,200);
    const response=await update.json();
    assert.equal(response.point.slots[4].azimuth,42);
    assert.equal(response.point.slots[0].azimuth,point.slots[0].azimuth);
    assert.equal((await patch({coordinates:[37.51,55.81]})).status,200);
    assert.equal((await patch({noSidewalk:true},'district_editor')).status,200);
    router=makeRouter();
    const saved=(await (await get(overview,'prefecture_admin')).json()).points.find(p=>p.id===point.id);
    assert.equal(saved.slots[4].azimuth,42);
    assert.deepEqual(saved.coordinates,[37.51,55.81]);
    assert.equal(saved.noSidewalk,true);
  } finally { await new Promise(resolve=>srv.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});

test('production catalog: all points and slots, if privately provisioned', async (t) => {
  let catalog;
  try { catalog=JSON.parse(await readFile(new URL('../assets/yard-path-points.json', import.meta.url),'utf8')); }
  catch(error) { if(error.code==='ENOENT') return t.skip('private catalog not provisioned'); throw error; }
  const {points}=catalog;
  const frames=points.flatMap(p=>p.slots);
  assert.equal(points.length,6563);
  assert.equal(new Set(points.map(p=>p.id)).size,6563);
  assert.equal(frames.length,16572);
  assert.equal(new Set(frames.map(f=>f.id)).size,16572);
  assert.equal(new Set(points.map(p=>p.district)).size,16);
  assert.ok(frames.every(f=>Number.isFinite(f.azimuth)&&f.azimuth>=0&&f.azimuth<360));
});
