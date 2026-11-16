import crypto from 'node:crypto';
import express from 'express';
import { createDpspCaptureRouter, captureThumbnailHandler } from './dpsp-capture.js';
import { resizeJpeg } from '../image-resize.js';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN=/^[0-9a-f]{32}$/;

// Слаги районных страниц districts/<slug>.html: по ним строятся ссылки
// «На карте» в кабинете и таблице. Дубли с «ё» — на случай старых написаний.
export const DISTRICT_SLUGS=Object.freeze({
 'Аэропорт':'aeroport','Беговой':'begovoy','Бескудниковский':'beskudnikovskiy','Войковский':'voykovskiy',
 'Восточное Дегунино':'vostochnoe-degunino','Головинский':'golovinskiy','Дмитровский':'dmitrovskiy',
 'Западное Дегунино':'zapadnoe-degunino','Коптево':'koptevo','Левобережный':'levoberezhnyy',
 'Молжаниновский':'molzhaninovskiy','Савеловский':'savelovskiy','Савёловский':'savelovskiy',
 'Сокол':'sokol','Тимирязевский':'timiryazevskiy','Хорошевский':'horoshevskiy','Хорошёвский':'horoshevskiy',
 'Ховрино':'hovrino'
});
export const DPSP_CONDITIONS=Object.freeze({ok:'Исправно',repair:'Требует ремонта',broken:'Неисправно'});
export const DPSP_KINDS=Object.freeze({dp:'ДП',sp:'СП'});

// Родители — активные точки площадок из фотофиксации ДП/СП; район и вид уже
// назначены при импорте, поэтому кабинет не спрашивает их у оператора.
const siteBase=`SELECT p.id AS point_id,p.source_id,p.district,p.kind,p.address,p.latitude,p.longitude,
 (SELECT count(*) FROM dpsp_maf_items m WHERE m.point_id=p.id AND m.retired_at IS NULL)::int AS maf_count,
 (SELECT max(m.updated_at) FROM dpsp_maf_items m WHERE m.point_id=p.id AND m.retired_at IS NULL) AS last_maf_at,
 c.checked_at,c.comment AS checked_comment,
 COALESCE((SELECT f.status FROM playground_photo_slot_photos f WHERE f.point_id=p.id AND f.status IN ('pending','accepted') ORDER BY f.uploaded_at DESC LIMIT 1),
 (SELECT 'rework' FROM playground_photo_slot_photos f WHERE f.point_id=p.id AND f.status='rejected' ORDER BY f.reviewed_at DESC NULLS LAST LIMIT 1),'empty') AS photo_state,
 (SELECT t.token FROM photo_public_tokens t JOIN playground_photo_slot_photos f ON f.id=t.photo_id
  WHERE f.point_id=p.id AND t.revoked_at IS NULL ORDER BY t.created_at DESC LIMIT 1) AS photo_token
 FROM playground_photo_points p LEFT JOIN dpsp_site_checks c ON c.point_id=p.id
 WHERE p.retired_at IS NULL`;

const summaryQuery=`SELECT p.district,count(*)::int AS sites,count(c.point_id)::int AS checked,
 COALESCE(sum((SELECT count(*) FROM dpsp_maf_items m WHERE m.point_id=p.id AND m.retired_at IS NULL)),0)::int AS maf,
 COALESCE(sum((SELECT count(*) FROM dpsp_maf_photos ph JOIN dpsp_maf_items m ON m.id=ph.item_id
  WHERE m.point_id=p.id AND m.retired_at IS NULL AND ph.status='active')),0)::int AS photos
 FROM playground_photo_points p LEFT JOIN dpsp_site_checks c ON c.point_id=p.id
 WHERE p.retired_at IS NULL GROUP BY p.district ORDER BY p.district`;

const itemsQuery=`SELECT m.id,m.type_code,t.label AS type_label,m.quantity,m.condition,m.comment,m.created_at,m.updated_at,
 ph.id AS photo_id,(SELECT tk.token FROM dpsp_maf_photo_tokens tk WHERE tk.photo_id=ph.id AND tk.revoked_at IS NULL
  ORDER BY tk.created_at DESC LIMIT 1) AS photo_token
 FROM dpsp_maf_items m JOIN dpsp_maf_types t ON t.code=m.type_code
 LEFT JOIN dpsp_maf_photos ph ON ph.item_id=m.id AND ph.status='active'
 WHERE m.point_id=$1 AND m.retired_at IS NULL ORDER BY t.sort,m.created_at,m.id`;

const mafSheetQuery=`SELECT m.id,m.point_id,p.source_id,p.district,p.kind,p.address,m.type_code,t.label AS type_label,
 m.quantity,m.condition,m.comment,m.created_at,m.updated_at,
 ph.id AS photo_id,(SELECT tk.token FROM dpsp_maf_photo_tokens tk WHERE tk.photo_id=ph.id AND tk.revoked_at IS NULL
  ORDER BY tk.created_at DESC LIMIT 1) AS photo_token
 FROM dpsp_maf_items m JOIN dpsp_maf_types t ON t.code=m.type_code
 JOIN playground_photo_points p ON p.id=m.point_id
 LEFT JOIN dpsp_maf_photos ph ON ph.item_id=m.id AND ph.status='active'
 WHERE m.retired_at IS NULL ORDER BY p.district,p.kind,p.source_row,m.created_at,m.id`;

// Фильтры списка площадок: вычисляемые колонки (maf_count, checked_at) живут
// во внешнем SELECT, поэтому запрос всегда оборачивается в подзапрос.
function sitesWhere(query){
 const where=[],params=[];
 if(query.district){params.push(query.district);where.push(`s.district=$${params.length}`)}
 if(query.kind&&['dp','sp'].includes(query.kind)){params.push(query.kind);where.push(`s.kind=$${params.length}`)}
 if(query.q){params.push(`%${query.q}%`);where.push(`(s.address ILIKE $${params.length} OR s.source_id ILIKE $${params.length})`)}
 if(query.status==='checked')where.push('s.checked_at IS NOT NULL');
 if(query.status==='unchecked')where.push('s.checked_at IS NULL');
 if(query.status==='maf')where.push('s.maf_count>0');
 if(query.status==='no_maf')where.push('s.maf_count=0');
 return {where,params};
}

const addSlug=row=>({...row,district_slug:DISTRICT_SLUGS[row.district]||null});

// Справочник отдаётся и отдельно (кабинет), и внутри sheet.json (таблица),
// чтобы скрипт таблицы не зашивал типы МАФ в код.
async function dictionaries(pool){
 const {rows:types}=await pool.query('SELECT code,label,kind,sort FROM dpsp_maf_types ORDER BY kind NULLS LAST,sort,label');
 const seen=new Map();
 for(const [name,slug] of Object.entries(DISTRICT_SLUGS)){
  if(!seen.has(slug)||!name.includes('ё'))seen.set(slug,{name,slug});
 }
 return {types,conditions:Object.entries(DPSP_CONDITIONS).map(([code,label])=>({code,label})),
  kinds:Object.entries(DPSP_KINDS).map(([code,label])=>({code,label})),
  districts:[...seen.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'))};
}

// Поля МАФ: тип — существующий код справочника, количество 1–999,
// состояние из трёх значений, комментарий до 2 000 символов.
function parseMafInput(body,{partial=false}={}){
 const out={};
 if(!partial||body.type_code!==undefined){
  const type=String(body.type_code||'').trim();
  if(!type||type.length>60)return {error:'Укажите тип МАФ.'};
  out.type_code=type;
 }
 if(!partial||body.quantity!==undefined){
  const quantity=body.quantity===undefined||body.quantity===''?1:Number(body.quantity);
  if(!Number.isInteger(quantity)||quantity<1||quantity>999)return {error:'Количество — целое число от 1 до 999.'};
  out.quantity=quantity;
 }
 if(!partial||body.condition!==undefined){
  const condition=body.condition===undefined||body.condition===''?'ok':String(body.condition);
  if(!DPSP_CONDITIONS[condition])return {error:'Неизвестное состояние.'};
  out.condition=condition;
 }
 if(!partial||body.comment!==undefined){
  const comment=String(body.comment||'').trim();
  if(comment.length>2000)return {error:'Комментарий длиннее 2 000 символов.'};
  out.comment=comment;
 }
 return out;
}

export function createDpspMafRouter({pool,authenticate}) {
 const router=express.Router();
 router.get('/capture-thumb/:token',captureThumbnailHandler(pool));
 // Превью по токену — единственный маршрут без сессии: Google Sheets =IMAGE()
 // не умеет заголовок Authorization. Токен неугадываемый и отзывается.
 router.get('/photo-thumb/:token',async(req,res,next)=>{try{
  const token=String(req.params.token||'').replace(/\.jpg$/i,'');
  if(!TOKEN.test(token))return res.status(404).json({error:'Фото не найдено.'});
  const {rows}=await pool.query(`SELECT t.photo_id,f.photo_bytes FROM dpsp_maf_photo_tokens t
   JOIN dpsp_maf_photos f ON f.id=t.photo_id WHERE t.token=$1 AND t.revoked_at IS NULL`,[token]);
  if(!rows[0])return res.status(404).json({error:'Фото не найдено.'});
  const cached=await pool.query('SELECT photo_bytes,photo_mime_type FROM dpsp_maf_thumbs WHERE photo_id=$1',[rows[0].photo_id]);
  let thumb=cached.rows[0];
  if(!thumb){
   const preview=await resizeJpeg(rows[0].photo_bytes,{max:320,quality:80});
   await pool.query(`INSERT INTO dpsp_maf_thumbs (photo_id,photo_bytes,photo_mime_type,photo_size,width,height)
    VALUES ($1,$2,'image/jpeg',$3,$4,$5) ON CONFLICT (photo_id) DO NOTHING`,
    [rows[0].photo_id,preview.bytes,preview.bytes.length,preview.width,preview.height]);
   thumb={photo_bytes:preview.bytes,photo_mime_type:'image/jpeg'};
  }
  res.set('Cache-Control','public, max-age=86400, immutable').set('X-Robots-Tag','noindex')
   .type(thumb.photo_mime_type).send(thumb.photo_bytes);
 }catch(e){next(e)}});
 // Только префектура: районные учётки в оцифровке МАФ не участвуют.
 router.use(authenticate,(req,res,next)=>req.user.role==='prefecture_admin'?next():res.status(403).json({error:'Кабинет оцифровки доступен префектуре.'}));
 router.use('/workflow',createDpspCaptureRouter({pool}));
 router.param('id',(req,res,next,id)=>UUID.test(id)?next():res.status(400).json({error:'Неверный ID.'}));
 const audit=(client,userId,action,objectKey,metadata)=>client.query(
  'INSERT INTO audit_log (actor_user_id,action,object_key,metadata) VALUES ($1,$2,$3,$4::jsonb)',
  [userId,action,objectKey,JSON.stringify(metadata)]);
 router.get('/summary',async(req,res,next)=>{try{
  const {rows}=await pool.query(summaryQuery);
  const totals=rows.reduce((acc,row)=>({sites:acc.sites+row.sites,checked:acc.checked+row.checked,maf:acc.maf+row.maf,photos:acc.photos+row.photos}),
   {sites:0,checked:0,maf:0,photos:0});
  res.set('Cache-Control','no-store').json({generated_at:new Date().toISOString(),districts:rows,totals});
 }catch(e){next(e)}});
 router.get('/dictionaries',async(req,res,next)=>{try{
  res.set('Cache-Control','no-store').json(await dictionaries(pool));
 }catch(e){next(e)}});
 router.get('/sites',async(req,res,next)=>{try{
  const {where,params}=sitesWhere(req.query);
  const limit=Math.min(Math.max(Number(req.query.limit)||3000,1),5000);
  const offset=Math.max(Number(req.query.offset)||0,0);
  const sql=`SELECT * FROM (${siteBase}) s${where.length?` WHERE ${where.join(' AND ')}`:''}
   ORDER BY s.district,s.kind,s.address LIMIT ${limit} OFFSET ${offset}`;
  const {rows}=await pool.query(sql,params);
  res.set('Cache-Control','no-store').json({sites:rows.map(addSlug)});
 }catch(e){next(e)}});
 router.get('/sites/:id',async(req,res,next)=>{try{
  const site=(await pool.query(`${siteBase} AND p.id=$1`,[req.params.id])).rows[0];
  if(!site)return res.status(404).json({error:'Площадка не найдена.'});
  const {rows}=await pool.query(itemsQuery,[site.point_id]);
  res.set('Cache-Control','no-store').json({
   site:addSlug(site),
   items:rows.map(item=>({...item,condition_label:DPSP_CONDITIONS[item.condition]||item.condition})),
  });
 }catch(e){next(e)}});
 router.post('/sites/:id/maf',async(req,res,next)=>{try{
  const parsed=parseMafInput(req.body||{});
  if(parsed.error)return res.status(422).json({error:parsed.error});
  if(!(await pool.query('SELECT 1 FROM dpsp_maf_types WHERE code=$1',[parsed.type_code])).rows[0])
   return res.status(422).json({error:'Неизвестный тип МАФ.'});
  if(!(await pool.query('SELECT 1 FROM playground_photo_points WHERE id=$1 AND retired_at IS NULL',[req.params.id])).rows[0])
   return res.status(404).json({error:'Площадка не найдена.'});
  const id=crypto.randomUUID();
  await pool.query(`INSERT INTO dpsp_maf_items (id,point_id,type_code,quantity,condition,comment,created_by)
   VALUES ($1,$2,$3,$4,$5,$6,$7)`,[id,req.params.id,parsed.type_code,parsed.quantity,parsed.condition,parsed.comment,req.user.sub]);
  await audit(pool,req.user.sub,'dpsp_maf_created',req.params.id,{mafId:id,type:parsed.type_code,quantity:parsed.quantity});
  res.status(201).json({id});
 }catch(e){next(e)}});
 router.patch('/maf/:id',async(req,res,next)=>{try{
  const parsed=parseMafInput(req.body||{},{partial:true});
  if(parsed.error)return res.status(422).json({error:parsed.error});
  const fields=Object.keys(parsed);
  if(!fields.length)return res.status(422).json({error:'Нет изменений.'});
  if(parsed.type_code&&!(await pool.query('SELECT 1 FROM dpsp_maf_types WHERE code=$1',[parsed.type_code])).rows[0])
   return res.status(422).json({error:'Неизвестный тип МАФ.'});
  const updated=await pool.query(`UPDATE dpsp_maf_items SET ${fields.map((field,i)=>`${field}=$${i+2}`).join(',')},updated_at=now()
   WHERE id=$1 AND retired_at IS NULL RETURNING id`,[req.params.id,...fields.map(f=>parsed[f])]);
  if(!updated.rowCount)return res.status(404).json({error:'МАФ не найден.'});
  await audit(pool,req.user.sub,'dpsp_maf_updated',req.params.id,{changes:fields});
  res.json({id:updated.rows[0].id});
 }catch(e){next(e)}});
 router.delete('/maf/:id',async(req,res,next)=>{try{
  const retired=await pool.query('UPDATE dpsp_maf_items SET retired_at=now() WHERE id=$1 AND retired_at IS NULL RETURNING id',[req.params.id]);
  if(!retired.rowCount)return res.status(404).json({error:'МАФ не найден.'});
  await pool.query('UPDATE dpsp_maf_photo_tokens SET revoked_at=now() WHERE item_id=$1 AND revoked_at IS NULL',[req.params.id]);
  await audit(pool,req.user.sub,'dpsp_maf_retired',req.params.id,{});
  res.json({retired:true});
 }catch(e){next(e)}});
 // Снимок МАФ: замена переводит старый в «superseded» и отзывает его токен,
 // поэтому устаревшая ссылка в таблице перестаёт открываться сразу.
 router.put('/maf/:id/photo',express.raw({type:['image/jpeg','image/png','image/webp'],limit:'5mb'}),async(req,res,next)=>{
  const valid=validatePhotoUpload(req.body,req.get('content-type'));
  if(!valid.valid)return res.status(422).json({error:valid.error});
  let c;
  try{
   c=await pool.connect();await c.query('BEGIN');
   const item=await c.query('SELECT id FROM dpsp_maf_items WHERE id=$1 AND retired_at IS NULL FOR UPDATE',[req.params.id]);
   if(!item.rows[0]){await c.query('ROLLBACK');return res.status(404).json({error:'МАФ не найден.'})}
   await c.query(`UPDATE dpsp_maf_photos SET status='superseded' WHERE item_id=$1 AND status='active'`,[req.params.id]);
   const photoId=crypto.randomUUID();
   await c.query(`INSERT INTO dpsp_maf_photos (id,item_id,status,photo_bytes,photo_mime_type,photo_filename,photo_size,uploaded_by)
    VALUES ($1,$2,'active',$3,$4,$5,$6,$7)`,
    [photoId,req.params.id,req.body,valid.mimeType,safePhotoFilename(req.get('x-photo-filename')),req.body.length,req.user.sub]);
   await c.query('UPDATE dpsp_maf_photo_tokens SET revoked_at=now() WHERE item_id=$1 AND revoked_at IS NULL',[req.params.id]);
   const token=crypto.randomBytes(16).toString('hex');
   await c.query('INSERT INTO dpsp_maf_photo_tokens (token,photo_id,item_id) VALUES ($1,$2,$3)',[token,photoId,req.params.id]);
   await audit(c,req.user.sub,'dpsp_maf_photo_uploaded',req.params.id,{photoId,itemId:req.params.id});
   await c.query('COMMIT');
   res.status(201).json({photo_id:photoId,thumb_token:token});
  }catch(e){if(c)try{await c.query('ROLLBACK')}catch{};next(e)}
  finally{if(c)c.release()}
 });
 // Отметка «оцифровано»: площадка без МАФ — тоже результат оцифровки.
 router.post('/sites/:id/check',async(req,res,next)=>{try{
  const checked=(req.body||{}).checked!==false;
  const comment=String((req.body||{}).comment||'').trim();
  if(comment.length>2000)return res.status(422).json({error:'Комментарий длиннее 2 000 символов.'});
  if(!(await pool.query('SELECT 1 FROM playground_photo_points WHERE id=$1 AND retired_at IS NULL',[req.params.id])).rows[0])
   return res.status(404).json({error:'Площадка не найдена.'});
  if(checked){
   await pool.query(`INSERT INTO dpsp_site_checks (point_id,checked_by,checked_at,comment) VALUES ($1,$2,now(),$3)
    ON CONFLICT (point_id) DO UPDATE SET checked_by=$2,checked_at=now(),comment=$3`,[req.params.id,req.user.sub,comment]);
   await audit(pool,req.user.sub,'dpsp_site_checked',req.params.id,{comment});
  }else{
   await pool.query('DELETE FROM dpsp_site_checks WHERE point_id=$1',[req.params.id]);
   await audit(pool,req.user.sub,'dpsp_site_unchecked',req.params.id,{});
  }
  res.json({checked});
 }catch(e){next(e)}});
 // Полный срез для Google-таблицы: площадки-родители, МАФ-дети и справочники.
 // Токены, а не готовые URL: базовый адрес знает скрипт таблицы.
 router.get('/sheet.json',async(req,res,next)=>{try{
  const sites=await pool.query(`${siteBase} ORDER BY p.district,p.kind,p.source_row`);
  const maf=await pool.query(mafSheetQuery);
  res.set('Cache-Control','no-store').json({
   generated_at:new Date().toISOString(),
   sites:sites.rows.map(addSlug),
   maf:maf.rows.map(addSlug),
   dictionaries:await dictionaries(pool),
  });
 }catch(e){next(e)}});
 router.use((err,_req,res,next)=>err.code==='55000'?res.status(409).json({error:'Объект уже передан на приёмку. Обновите список.'}):next(err));
 return router;
}
