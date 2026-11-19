import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import {execFileSync} from 'node:child_process';
import {photoServiceDatabaseConfig} from '../src/config.js';
import {createDpspMafRouter} from '../src/tpu-points/dpsp-maf.js';
import {DPSP_EDITOR} from '../src/tpu-points/dpsp-access.js';
import {authenticateMapUser,hashPassword} from '../src/auth.js';
assert.equal(process.env.PLAYGROUND_DISPOSABLE_DB,'yes','Disposable database required');
const pool=new pg.Pool(photoServiceDatabaseConfig(process.env));
let server;
try {
 execFileSync(process.execPath,['scripts/migrate.js']);
 const {rows:[{id:point,district}]}=await pool.query("SELECT id,district FROM playground_photo_points WHERE retired_at IS NULL AND kind='dp' ORDER BY id LIMIT 1");
 const {rows:[foreign]}=await pool.query(
  'SELECT id,district FROM playground_photo_points WHERE retired_at IS NULL AND district<>$1 ORDER BY id LIMIT 1',[district]);
 const password='disposable-operator-password';
 const hash=await hashPassword(password);
 const districtUsers={};
 for(const [login,assigned] of [['test-dpsp-local',district],['test-dpsp-foreign',foreign.district]]){
  const {rows:[account]}=await pool.query(`INSERT INTO users (id,email,display_name,role,district,password_hash)
   VALUES ($1,$1,$1,$2,$3,$4) RETURNING *`,[login,DPSP_EDITOR,assigned,hash]);
  assert.equal(await authenticateMapUser(account,''),false);
  assert.equal(await authenticateMapUser(account,password),true);
  districtUsers[login]=account;
 }
 const local='test-dpsp-local', outsider='test-dpsp-foreign';
 const legacy=async()=>JSON.stringify((await pool.query("SELECT id,status,encode(photo_bytes,'hex') AS bytes FROM playground_photo_slot_photos ORDER BY id")).rows);
 const before=await legacy();
 const app=express();app.use(express.json());
 app.use('/dpsp',createDpspMafRouter({pool,authenticate(req,res,next){
  if(!req.get('x-role'))return res.sendStatus(401);
  const role=req.get('x-role'),account=districtUsers[role];
  req.user=account?{...account,sub:account.id}:{sub:'test-admin',role};next();
 }}));
 app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 server=app.listen(0,'0.0.0.0');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port+'/dpsp';
 const call=(path,method='GET',body,role='prefecture_admin')=>fetch(base+path,{method,headers:{...(role?{'x-role':role}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const w='/workflow/sites/'+point;
 assert.equal((await call('/workflow/sites','GET',undefined,null)).status,401);
 for(const role of ['district_editor','reviewer'])assert.equal((await call('/workflow/sites','GET',undefined,role)).status,403);
 assert.equal((await call(w+'/submit','POST',{})).status,422);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1kAAAAASUVORK5CYII=','base64');
 const upload=(path,role='prefecture_admin')=>fetch(base+path,{method:'PUT',headers:{'x-role':role,'content-type':'image/png'},body:png});
 const ownWork=await (await call('/workflow/sites?district='+encodeURIComponent(foreign.district),'GET',undefined,local)).json();
 assert.ok(ownWork.sites.some(p=>p.point_id===point));
 assert.ok(ownWork.sites.every(p=>p.district===district));
 assert.deepEqual((await (await call('/dictionaries','GET',undefined,local)).json()).districts.map(item=>item.name),[district.replace('ё','е')]);
 for(const path of ['/summary','/sheet.json','/workflow/sheet.json','/workflow/sites?queue=review','/workflow/sites?queue=accepted']){
  assert.equal((await call(path,'GET',undefined,local)).status,403,path);
 }
 assert.equal((await call('/sites/'+point,'GET',undefined,outsider)).status,404);
 assert.equal((await call(w,'GET',undefined,outsider)).status,404);
 assert.equal((await upload(w+'/photos',outsider)).status,404);
 assert.equal((await call(w+'/submit','POST',{},outsider)).status,404);
 assert.equal((await call(w+'/decision','POST',{decision:'accepted'},local)).status,403);
 const firstPhoto=await upload(w+'/photos',local);
 assert.equal(firstPhoto.status,201);
 const {photo_id:photoId}=await firstPhoto.json();
 assert.equal((await call(w+'/photos/'+photoId,'GET',undefined,local)).status,200);
 assert.equal((await call(w+'/photos/'+photoId,'GET',undefined,outsider)).status,404);
 assert.equal((await call(w+'/photos/'+photoId,'DELETE',undefined,outsider)).status,404);
 assert.equal((await call(w+'/submit','POST',{})).status,422);
 const type=(await pool.query("SELECT code FROM dpsp_maf_types WHERE kind='dp' OR kind IS NULL ORDER BY sort LIMIT 1")).rows[0].code;
 const newMaf={type_code:type,quantity:1,condition:'ok',comment:'Disposable integration test'};
 assert.equal((await call('/sites/'+point+'/maf','POST',newMaf,outsider)).status,404);
 const added=await call('/sites/'+point+'/maf','POST',newMaf,local);
 assert.equal(added.status,201);const item=await added.json();
 const maf=item.id||item.item?.id;
 assert.ok(maf,JSON.stringify(item));
 assert.equal((await call(w+'/submit','POST',{})).status,422);
 assert.equal((await call('/maf/'+maf,'PATCH',{quantity:2},outsider)).status,404);
 assert.equal((await call('/maf/'+maf,'DELETE',undefined,outsider)).status,404);
 assert.equal((await upload('/maf/'+maf+'/photo',outsider)).status,404);
 assert.equal((await upload('/maf/'+maf+'/photo',local)).status,201);
 assert.equal((await call('/workflow/maf/'+maf+'/photo','GET',undefined,local)).status,200);
 assert.equal((await call('/workflow/maf/'+maf+'/photo','GET',undefined,outsider)).status,404);
 assert.equal((await call(w+'/submit','POST',{},local)).status,200);
 assert.ok(!(await (await call('/workflow/sites')).json()).sites.some(p=>p.point_id===point));
 assert.ok((await (await call('/workflow/sites?queue=review')).json()).sites.some(p=>p.point_id===point));
 assert.equal((await upload(w+'/photos')).status,409);
 assert.equal((await call('/maf/'+maf,'PATCH',{quantity:2})).status,409);
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await assert.rejects(client.query('UPDATE dpsp_maf_items SET quantity=2 WHERE id=$1',[maf]),e=>e.code==='55000');
  await client.query('ROLLBACK');
 }finally{client.release();}
 assert.equal((await call(w+'/decision','POST',{decision:'rework',comment:''})).status,422);
 assert.equal((await call(w+'/decision','POST',{decision:'rework',comment:'Переснять обзор'})).status,200);
 assert.ok((await (await call('/workflow/sites')).json()).sites.some(p=>p.point_id===point&&p.review_comment==='Переснять обзор'));
 assert.equal((await upload(w+'/photos')).status,201);
 assert.equal((await call(w+'/submit','POST',{})).status,200);
 assert.equal((await call(w+'/decision','POST',{decision:'accepted',comment:''})).status,200);
 assert.ok((await (await call('/workflow/sites?queue=accepted')).json()).sites.some(p=>p.point_id===point));
 assert.equal((await call(w+'/decision','POST',{decision:'rework',comment:'Повтор'})).status,409);
 const sheet=await (await call('/workflow/sheet.json')).json();
 assert.ok(sheet.sites.some(p=>p.point_id===point&&p.state==='accepted'&&p.capture_count===2));
 assert.ok(sheet.maf.some(p=>p.maf_id===maf&&p.photo_token));
 assert.equal(sheet.photos.filter(p=>p.point_id===point).length,2);
 const token=sheet.photos.find(p=>p.point_id===point).photo_token;
 assert.equal((await fetch(base+'/capture-thumb/'+token+'.jpg')).status,200);
 assert.equal(await legacy(),before,'Old photos and review results are unchanged');
 console.log('PASS: DP/SP PostgreSQL auth, overview photos, MAF photo requirement, submit, SQL locks, return, resubmit, accept, sheet snapshot, thumbnails, legacy preservation');
} finally {if(server)await new Promise(r=>server.close(r));await pool.end();}
