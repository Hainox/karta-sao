import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import {createSidewalkPointsRouter,sidewalkQueueFromRows,sidewalkQueueQuery} from '../src/tpu-points/sidewalk-points.js';
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
const rows=ids.map((id,i)=>({point_id:id,label:'Т1.'+i,district:'Аэропорт',heading:90,longitude:37.5,latitude:55.8,...(i===1?{photo_id:id,photo_status:'pending',uploaded_at:'2026-11-02T00:00:00Z'}:{}),...(i===2?{photo_id:id,photo_status:'accepted',uploaded_at:'2026-11-02T00:00:00Z',rejected_photo_id:id,rejected_comment:'старый возврат'}:{}),...(i===3?{rejected_photo_id:id,rejected_comment:'исправить',rejected_at:'2026-11-01T00:00:00Z'}:{})}));
const queue=sidewalkQueueFromRows(rows);assert.deepEqual(queue.counts,{total:4,empty:1,pending:1,accepted:1,rework:1});assert.equal(queue.pending[0].point_id,ids[1]);assert.equal(queue.rework[0].photo_id,null);assert.equal(queue.rework[0].rejected_comment,'исправить');assert.match(sidewalkQueueQuery,/WHERE p.retired_at IS NULL/);
const pool={query:async(sql,params)=>sql===sidewalkQueueQuery?{rows}:{rows:[{id:ids[0],district:'Аэропорт'}]}};
const app=express();app.use(express.json());app.use(createSidewalkPointsRouter({pool,boundary:{},authenticate:(req,res,next)=>{req.user={role:req.headers['x-role']||'prefecture_admin',district:'Аэропорт'};next();}}));app.use((e,req,res,next)=>res.status(500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
try{
 const response=await fetch(base+'/queue');assert.equal(response.status,200);assert.deepEqual((await response.json()).counts,queue.counts);
 for(const path of ['/queue','/report.xlsx'])assert.equal((await fetch(base+path,{headers:{'x-role':'district_editor'}})).status,403);
 const report=await fetch(base+'/report.xlsx');assert.equal(report.status,200);assert.match(report.headers.get('content-type'),/spreadsheetml/);const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(await report.arrayBuffer()));assert.deepEqual(book.worksheets.map(x=>x.name),['Свод по районам','Точки','На доработке']);assert.equal(book.getWorksheet('Точки').rowCount,5);assert.equal(book.getWorksheet('На доработке').getRow(2).getCell(3).value,'исправить');
 console.log('PASS queue states, resubmission, retired filter, route ordering, role guards, Excel sheets/details/rework');
}finally{server.close();}
