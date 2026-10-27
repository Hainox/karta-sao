import crypto from 'node:crypto';
import express from 'express';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const roles=new Set(['prefecture_admin','reviewer','district_editor']);
const pointQuery=`SELECT p.id,p.source_key,p.source_id,p.source_row,p.district,p.district_code,p.kind,p.address,p.longitude,p.latitude,p.source_properties,
 COALESCE((SELECT f.status FROM playground_photo_slot_photos f WHERE f.point_id=p.id AND f.status IN ('pending','accepted') ORDER BY f.uploaded_at DESC LIMIT 1),
 (SELECT 'rework' FROM playground_photo_slot_photos f WHERE f.point_id=p.id AND f.status='rejected' ORDER BY f.reviewed_at DESC NULLS LAST LIMIT 1),'empty') AS photo_state
 FROM playground_photo_points p JOIN playground_photo_slots s ON s.point_id=p.id`;

export function createPlaygroundPhotoRouter({pool,authenticate}) {
 const router=express.Router();
 router.get('/public',async(req,res,next)=>{try{
  const district=typeof req.query.district==='string'?req.query.district.trim():'';
  if(!district)return res.status(400).json({error:'Укажите район.'});
  const result=await pool.query(pointQuery+' WHERE p.district=$1 ORDER BY p.kind,p.source_row',[district]);
  res.set('Cache-Control','no-store').json({points:result.rows});
 }catch(e){next(e)}});
 router.use(authenticate,(req,res,next)=>roles.has(req.user.role)&&
  (req.user.role!=='district_editor'||req.user.district)?next():res.status(403).json({error:'Нет доступа.'}));
 router.param('id',(req,res,next,id)=>UUID.test(id)?next():res.status(400).json({error:'Неверный ID точки.'}));
 const permitted=(user,point)=>user.role!=='district_editor'||user.district===point.district;
 router.get('/:id/photo',async(req,res,next)=>{try{
  const p=(await pool.query('SELECT id,district FROM playground_photo_points WHERE id=$1',[req.params.id])).rows[0];
  if(!p||!permitted(req.user,p))return res.status(404).json({error:'Точка не найдена.'});
  const f=(await pool.query(`SELECT id,status,photo_mime_type,photo_bytes,review_comment FROM playground_photo_slot_photos
    WHERE point_id=$1 AND status IN ('pending','accepted') ORDER BY uploaded_at DESC LIMIT 1`,[p.id])).rows[0];
  if(!f)return res.status(404).json({error:'Фото отсутствует.'});
  res.set('Cache-Control','private, no-store');res.type(f.photo_mime_type).send(f.photo_bytes);
 }catch(e){next(e)}});
 router.put('/:id/photo',(req,res,next)=>req.user.role==='reviewer'?res.status(403).json({error:'Фото загружает район.'}):next(),
  express.raw({type:['image/jpeg','image/png','image/webp'],limit:'5mb'}),async(req,res,next)=>{
  const valid=validatePhotoUpload(req.body,req.get('content-type'));
  if(!valid.valid)return res.status(422).json({error:valid.error});
  let c;
  try{
   c=await pool.connect();await c.query('BEGIN');
   const p=(await c.query('SELECT id,district FROM playground_photo_points WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
   if(!p||!permitted(req.user,p)){await c.query('ROLLBACK');return res.status(404).json({error:'Точка не найдена.'})}
   const active=await c.query(`SELECT 1 FROM playground_photo_slot_photos WHERE point_id=$1 AND status IN ('pending','accepted')`,[p.id]);
   if(active.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'Слот уже занят.'})}
   const id=crypto.randomUUID(),status=req.user.role==='prefecture_admin'?'accepted':'pending';
   await c.query(`INSERT INTO playground_photo_slot_photos(id,point_id,status,photo_bytes,photo_mime_type,photo_filename,photo_size,uploaded_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,p.id,status,req.body,valid.mimeType,safePhotoFilename(req.get('x-photo-filename')),req.body.length,req.user.sub]);
   await c.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
    [req.user.sub,'playground_photo_uploaded',p.id,JSON.stringify({pointId:p.id,photoId:id})]);
   await c.query('COMMIT');res.status(201).json({id,status});
  }catch(e){if(c)try{await c.query('ROLLBACK')}catch{};if(e.code==='23505')return res.status(409).json({error:'Слот уже занят.'});next(e)}
  finally{if(c)c.release()}
 });
 router.post('/:id/review',(req,res,next)=>req.user.role==='prefecture_admin'?next():res.status(403).json({error:'Проверка доступна префектуре.'}),
 async(req,res,next)=>{let c;try{
  const decision=req.body?.decision,comment=String(req.body?.comment||'').trim();
  if(!['accepted','rejected'].includes(decision)||comment.length>2000||(decision==='rejected'&&!comment))return res.status(422).json({error:'Укажите решение и причину возврата.'});
  c=await pool.connect();await c.query('BEGIN');
  const found=await c.query(`UPDATE playground_photo_slot_photos SET status=$2,review_comment=$3,reviewed_by=$4,reviewed_at=now()
    WHERE id=(SELECT id FROM playground_photo_slot_photos WHERE point_id=$1 AND status='pending' ORDER BY uploaded_at DESC LIMIT 1)
    AND status='pending' RETURNING id`,[req.params.id,decision,comment,req.user.sub]);
  if(!found.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'Нет фото, ожидающего проверки.'})}
  await c.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
   [req.user.sub,'playground_photo_reviewed',req.params.id,JSON.stringify({photoId:found.rows[0].id,decision})]);
  await c.query('COMMIT');res.json({status:decision});
 }catch(e){if(c)try{await c.query('ROLLBACK')}catch{};next(e)}finally{if(c)c.release()}});
 return router;
}
