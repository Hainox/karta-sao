import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createObjectPhotoPointsRouter } from '../src/tpu-points/object-photo-points.js';
import { DIRECTION_OBJECTS } from '../src/tpu-points/direction-corrections.js';

async function serve(user, run) {
  const rows = new Map();
  const repository = {
    async listDirectionCorrections({ fids }) { return [...rows.values()].filter(row => fids.includes(row.fid)); },
    async updateDirectionCorrection(input) {
      const current = rows.get(input.fid);
      if ((current?.version ?? 0) !== input.expectedVersion) throw Object.assign(new Error('stale'), { status: 409 });
      const row = { fid: input.fid, longitude: input.longitude, latitude: input.latitude, azimuth: input.azimuth, version: (current?.version ?? 0) + 1 };
      rows.set(input.fid, row); return row;
    }
  };
  const app = express(); app.use(express.json());
  app.use(createObjectPhotoPointsRouter({ repository, authenticate: (req,res,next) => { if (!user) return res.status(401).json({error:'login'}); req.user = {...user,sub:'pref-test'}; next(); }, boundary:{type:'FeatureCollection',features:[]} }));
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const server = app.listen(0); await new Promise(resolve=>server.once('listening',resolve));
  try { await run('http://127.0.0.1:'+server.address().port, rows); }
  finally { await new Promise(resolve=>server.close(resolve)); }
}
const object = DIRECTION_OBJECTS.get(8);
const input = { longitude:object.longitude, latitude:object.latitude, azimuth:90, expectedVersion:0 };
const patch = (base,body=input,id=8)=>fetch(base+'/directions/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('87 исходных направлений; читать корректировки можно без входа, редактирует только префектура', async()=>{
  assert.equal(DIRECTION_OBJECTS.size,87);
  for (const user of [null,{role:'district_editor',district:object.district},{role:'reviewer'}]) await serve(user,async(base,rows)=>{
    assert.equal((await fetch(base+'/directions/public')).status,200);
    assert.equal((await patch(base)).status,user?403:401);
    assert.equal(rows.size,0);
  });
});

test('положение и азимут сохраняются вместе, версии защищают от потери чужих изменений',async()=>{
  await serve({role:'prefecture_admin'},async(base,rows)=>{
    const result=await patch(base); assert.equal(result.status,200);
    assert.equal((await result.json()).correction.azimuth,90);
    assert.equal((await patch(base,{...input,azimuth:180})).status,409);
    assert.equal((await patch(base,{...input,longitude:input.longitude+0.00001,azimuth:180,expectedVersion:1})).status,200);
    const data=await(await fetch(base+'/directions/public?district='+encodeURIComponent(object.district))).json();
    assert.equal(data.corrections.length,1);assert.equal(data.corrections[0].version,2);assert.equal(data.corrections[0].azimuth,180);
    assert.equal(data.corrections[0].longitude,input.longitude+0.00001);
    assert.equal((await(await fetch(base+'/directions/public?district='+encodeURIComponent('Аэропорт'))).json()).corrections.length,0);
    assert.equal(rows.size,1);
  });
});

test('проверяются ID, границы района, координаты, азимут и версия',async()=>{
  await serve({role:'prefecture_admin'},async(base,rows)=>{
    for(const invalid of [{longitude:'37.5'},{latitude:null},{longitude:0,latitude:0},{azimuth:360},{azimuth:-1},{azimuth:'90'},{expectedVersion:-1},{expectedVersion:1.5}]) assert.equal((await patch(base,{...input,...invalid})).status,422);
    assert.equal((await patch(base,input,999999)).status,404);
    assert.equal(rows.size,0);
  });
});
