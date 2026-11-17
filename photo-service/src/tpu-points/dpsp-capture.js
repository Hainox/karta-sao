import crypto from 'node:crypto';
import express from 'express';
import { resizeJpeg } from '../image-resize.js';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routes={work:"(w.state IS NULL OR w.state='rework')",review:"w.state='submitted'",accepted:"w.state='accepted'"};
const error=(status,message)=>Object.assign(new Error(message),{status});
const own=(o,k)=>Object.hasOwn(o,k);
const photosSql="SELECT id,photo_filename,uploaded_at FROM dpsp_capture_photos WHERE point_id=$1 AND status='active' ORDER BY uploaded_at,id";

export function captureQueueFilter(query={}){
 const queue=query.queue||'work';
 if(!own(routes,queue))throw error(400,'Неизвестная очередь.');
 const where=[routes[queue]],params=[];
 if(query.district){params.push(String(query.district));where.push('p.district=$'+params.length);}
 if(query.kind){
  if(!['dp','sp'].includes(query.kind))throw error(400,'Неизвестный вид площадки.');
  params.push(query.kind);where.push('p.kind=$'+params.length);
 }
 return {where,params};
}

export function checkCaptureCompletion({photos,maf,missing},noMaf){
 if(!photos)return 'Загрузите хотя бы одно новое обзорное фото площадки.';
 if(!maf&&noMaf!==true)return 'Подтвердите отсутствие МАФ на площадке.';
 if(missing)return 'Загрузите фотографию каждого обнаруженного МАФ.';
 return null;
}

export function captureDecision(state,decision,comment){
 if(state!=='submitted')throw error(409,'Объект уже обработан или не отправлен на приёмку.');
 if(!['accepted','rework'].includes(decision))throw error(422,'Выберите решение.');
 if(typeof comment!=='string'||comment.length>2000)throw error(422,'Комментарий не должен превышать 2000 символов.');
 if(decision==='rework'&&!comment.trim())throw error(422,'Укажите причину возврата.');
 return {decision,comment:comment.trim()};
}

// Миниатюра доступна только по непрогнозируемой, отзываемой ссылке;
 // оригинал по-прежнему отдаётся через авторизованный кабинет.
export function captureThumbnailHandler(pool){
 return async(req,res,next)=>{try{
  const token=String(req.params.token||'').replace(/\.jpg$/i,'');
  if(!/^[0-9a-f]{32}$/.test(token))return res.sendStatus(404);
  const {rows}=await pool.query(`SELECT f.id,tb.photo_bytes AS thumb
   FROM dpsp_capture_photo_tokens t
   JOIN dpsp_capture_photos f ON f.id=t.photo_id
   LEFT JOIN dpsp_capture_photo_thumbs tb ON tb.photo_id=f.id
   WHERE t.token=$1 AND t.revoked_at IS NULL AND f.status='active'`,[token]);
  if(!rows[0])return res.sendStatus(404);
  let bytes=rows[0].thumb;
  if(!bytes){
   const source=(await pool.query("SELECT photo_bytes FROM dpsp_capture_photos WHERE id=$1 AND status='active'",[rows[0].id])).rows[0];
   if(!source)return res.sendStatus(404);
   const preview=await resizeJpeg(source.photo_bytes,{max:320,quality:80});
   bytes=preview.bytes;
   await pool.query('INSERT INTO dpsp_capture_photo_thumbs(photo_id,photo_bytes) VALUES($1,$2) ON CONFLICT DO NOTHING',[rows[0].id,bytes]);
  }
  res.set('Cache-Control','private, no-store').set('X-Robots-Tag','noindex, nofollow').type('image/jpeg').send(bytes);
 }catch(e){next(e);}};
}

export function createDpspCaptureRouter({pool}){
 const router=express.Router();
 // Родительский роут уже проверил учётную запись префектуры.
 router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
 for(const p of ['id','photoId','mafId'])router.param(p,(_req,res,next,id)=>UUID.test(id)?next():res.status(400).json({error:'Неверный ID.'}));
 const audit=(c,req,action,point,meta={})=>c.query('INSERT INTO audit_log (actor_user_id,action,object_key,metadata) VALUES ($1,$2,$3,$4::jsonb)',[req.user.sub,action,point,JSON.stringify(meta)]);
 async function transaction(fn){
  const c=await pool.connect();
  try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
  catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}
  finally{c.release();}
 }
 async function lock(c,id){
  const p=await c.query('SELECT id FROM playground_photo_points WHERE id=$1 AND retired_at IS NULL FOR UPDATE',[id]);
  if(!p.rows[0])throw error(404,'Площадка не найдена.');
  return (await c.query('SELECT * FROM dpsp_capture_workflow WHERE point_id=$1',[id])).rows[0]||null;
 }
 const editable=w=>{if(w&&w.state!=='rework')throw error(409,'Объект уже передан на приёмку.');};
 router.get('/sites',async(req,res,next)=>{try{
  const {where,params}=captureQueueFilter(req.query);
  const {rows}=await pool.query(`SELECT p.id AS point_id,p.source_id,p.district,p.kind,p.address,
    p.longitude,p.latitude,w.state,w.submitted_at,w.reviewed_at,w.review_comment,
    (SELECT count(*) FROM dpsp_capture_photos f WHERE f.point_id=p.id AND f.status='active')::int AS capture_count,
    (SELECT count(*) FROM dpsp_maf_items m WHERE m.point_id=p.id AND m.retired_at IS NULL)::int AS maf_count
    FROM playground_photo_points p LEFT JOIN dpsp_capture_workflow w ON w.point_id=p.id
    WHERE p.retired_at IS NULL AND ${where.join(' AND ')} ORDER BY p.district,p.kind,p.address,p.id`,params);
  res.json({sites:rows});
 }catch(e){next(e);}});
 // Все таблицы получают один согласованный срез новой оцифровки.
 // Только метаданные и токены превью, без байтов фотографий.
 router.get('/sheet.json',async(req,res,next)=>{try{
  const c=await pool.connect();
  let result;
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const sites=await c.query(`SELECT p.id AS point_id,p.source_id,p.district,p.kind,p.address,p.latitude,p.longitude,
    COALESCE(w.state,'work') AS state,w.submitted_at,w.reviewed_at,w.review_comment,
    (SELECT count(*)::int FROM dpsp_capture_photos f WHERE f.point_id=p.id AND f.status='active') AS capture_count,
    (SELECT count(*)::int FROM dpsp_maf_items m WHERE m.point_id=p.id AND m.retired_at IS NULL) AS maf_count
    FROM playground_photo_points p LEFT JOIN dpsp_capture_workflow w ON w.point_id=p.id
    WHERE p.retired_at IS NULL ORDER BY p.district,p.kind,p.address,p.id`);
   const photos=await c.query(`SELECT f.id AS photo_id,f.point_id,f.photo_filename,f.uploaded_at,t.token AS photo_token
    FROM dpsp_capture_photos f JOIN playground_photo_points p ON p.id=f.point_id
    LEFT JOIN dpsp_capture_photo_tokens t ON t.photo_id=f.id AND t.revoked_at IS NULL
    WHERE f.status='active' AND p.retired_at IS NULL ORDER BY f.point_id,f.uploaded_at,f.id`);
   const maf=await c.query(`SELECT m.id AS maf_id,m.point_id,m.type_code,t.label AS type_label,m.quantity,m.condition,m.comment,
    m.updated_at, ph.id AS photo_id,
    (SELECT tk.token FROM dpsp_maf_photo_tokens tk WHERE tk.photo_id=ph.id AND tk.revoked_at IS NULL ORDER BY tk.created_at DESC LIMIT 1) AS photo_token
    FROM dpsp_maf_items m JOIN dpsp_maf_types t ON t.code=m.type_code
    JOIN playground_photo_points p ON p.id=m.point_id
    LEFT JOIN dpsp_maf_photos ph ON ph.item_id=m.id AND ph.status='active'
    WHERE m.retired_at IS NULL AND p.retired_at IS NULL ORDER BY m.point_id,t.sort,m.id`);
   await c.query('COMMIT');
   result={generated_at:new Date().toISOString(),sites:sites.rows,photos:photos.rows,maf:maf.rows};
  }catch(e){try{await c.query('ROLLBACK')}catch{}throw e;}finally{c.release();}
  res.json(result);
 }catch(e){next(e);}});
 router.get('/sites/:id',async(req,res,next)=>{try{
  const {id}=req.params;
  if(!(await pool.query('SELECT id FROM playground_photo_points WHERE id=$1 AND retired_at IS NULL',[id])).rows[0])throw error(404,'Площадка не найдена.');
  const [w,photos]=await Promise.all([pool.query('SELECT * FROM dpsp_capture_workflow WHERE point_id=$1',[id]),pool.query(photosSql,[id])]);
  res.json({workflow:w.rows[0]||null,photos:photos.rows});
 }catch(e){next(e);}});
 router.put('/sites/:id/photos',express.raw({type:['image/jpeg','image/png','image/webp'],limit:'5mb'}),async(req,res,next)=>{try{
  const valid=validatePhotoUpload(req.body,req.get('content-type'));
  if(!valid.valid)throw error(422,valid.error);
  const {id}=req.params;const photoId=crypto.randomUUID();
  await transaction(async c=>{
   editable(await lock(c,id));
   const count=Number((await c.query("SELECT count(*) FROM dpsp_capture_photos WHERE point_id=$1 AND status='active'",[id])).rows[0].count);
   if(count>=30)throw error(422,'Не более 30 обзорных фото на площадку.');
   await c.query(`INSERT INTO dpsp_capture_photos(id,point_id,status,photo_bytes,photo_mime_type,photo_filename,photo_size,uploaded_by)
      VALUES($1,$2,'active',$3,$4,$5,$6,$7)`,
      [photoId,id,req.body,valid.mimeType,safePhotoFilename(req.get('x-photo-filename')),req.body.length,req.user.sub]);
   await c.query('INSERT INTO dpsp_capture_photo_tokens(token,photo_id) VALUES($1,$2)',[crypto.randomBytes(16).toString('hex'),photoId]);
   await audit(c,req,'dpsp_capture_photo_added',id,{photoId});
  });
  res.status(201).json({photo_id:photoId});
 }catch(e){next(e);}});
 router.get('/sites/:id/photos/:photoId',async(req,res,next)=>{try{
  const {rows}=await pool.query("SELECT photo_bytes,photo_mime_type FROM dpsp_capture_photos WHERE id=$1 AND point_id=$2 AND status='active'",[req.params.photoId,req.params.id]);
  if(!rows[0])throw error(404,'Фото не найдено.');
  res.type(rows[0].photo_mime_type).send(rows[0].photo_bytes);
 }catch(e){next(e);}});
 router.delete('/sites/:id/photos/:photoId',async(req,res,next)=>{try{
  const {id,photoId}=req.params;
  await transaction(async c=>{
   editable(await lock(c,id));
   const result=await c.query("UPDATE dpsp_capture_photos SET status='superseded' WHERE id=$1 AND point_id=$2 AND status='active'",[photoId,id]);
   if(!result.rowCount)throw error(404,'Фото не найдено.');
   await c.query('UPDATE dpsp_capture_photo_tokens SET revoked_at=now() WHERE photo_id=$1 AND revoked_at IS NULL',[photoId]);
   await audit(c,req,'dpsp_capture_photo_removed',id,{photoId});
  });res.json({removed:true});
 }catch(e){next(e);}});
 router.get('/maf/:mafId/photo',async(req,res,next)=>{try{
  const {rows}=await pool.query(`SELECT f.photo_bytes,f.photo_mime_type FROM dpsp_maf_photos f JOIN dpsp_maf_items m ON m.id=f.item_id
      WHERE f.item_id=$1 AND f.status='active' AND m.retired_at IS NULL`,[req.params.mafId]);
  if(!rows[0])throw error(404,'Фото МАФ не найдено.');
  res.type(rows[0].photo_mime_type).send(rows[0].photo_bytes);
 }catch(e){next(e);}});
 router.post('/sites/:id/submit',async(req,res,next)=>{try{
  const {id}=req.params;
  await transaction(async c=>{
   const w=await lock(c,id);editable(w);
   const {rows:[counts]}=await c.query(`SELECT
    (SELECT count(*)::int FROM dpsp_capture_photos WHERE point_id=$1 AND status='active') AS photos,
    (SELECT count(*)::int FROM dpsp_maf_items WHERE point_id=$1 AND retired_at IS NULL) AS maf,
    (SELECT count(*)::int FROM dpsp_maf_items m WHERE m.point_id=$1 AND m.retired_at IS NULL AND NOT EXISTS
       (SELECT 1 FROM dpsp_maf_photos f WHERE f.item_id=m.id AND f.status='active')) AS missing`,[id]);
   const invalid=checkCaptureCompletion(counts,req.body?.noMaf);
   if(invalid)throw error(422,invalid);
   await c.query(`INSERT INTO dpsp_capture_workflow(point_id,state,submitted_by,submitted_at)
     VALUES($1,'submitted',$2,now()) ON CONFLICT(point_id) DO UPDATE SET state='submitted',submitted_by=$2,submitted_at=now(),
        reviewed_by=NULL,reviewed_at=NULL,review_comment=''`,[id,req.user.sub]);
   await audit(c,req,'dpsp_capture_submitted',id,{...counts,noMaf:req.body?.noMaf===true});
  });res.json({state:'submitted'});
 }catch(e){next(e);}});
 router.post('/sites/:id/decision',async(req,res,next)=>{try{
  const {id}=req.params;
  const decision=await transaction(async c=>{
   const w=await lock(c,id);const result=captureDecision(w?.state,req.body?.decision,req.body?.comment??'');
   await c.query('UPDATE dpsp_capture_workflow SET state=$2,reviewed_by=$3,reviewed_at=now(),review_comment=$4 WHERE point_id=$1',[id,result.decision,req.user.sub,result.comment]);
   await audit(c,req,'dpsp_capture_reviewed',id,result);
   return result;
  });res.json({state:decision.decision});
 }catch(e){next(e);}});
 return router;
}
