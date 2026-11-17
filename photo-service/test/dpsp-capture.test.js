import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { captureQueueFilter, checkCaptureCompletion, captureDecision, createDpspCaptureRouter } from '../src/tpu-points/dpsp-capture.js';

test('рабочая очередь исключает отправленные и принятые, возврат снова в работе',()=>{
 assert.deepEqual(captureQueueFilter({}).where,["(w.state IS NULL OR w.state='rework')"]);
 assert.deepEqual(captureQueueFilter({queue:'review',district:'Сокол',kind:'dp'}),{where:["w.state='submitted'",'p.district=$1','p.kind=$2'],params:['Сокол','dp']});
 assert.deepEqual(captureQueueFilter({queue:'accepted'}).where,["w.state='accepted'"]);
 assert.throws(()=>captureQueueFilter({queue:'all'}),{status:400});
 assert.throws(()=>captureQueueFilter({kind:'anything'}),{status:400});
});
test('для отправки требуется новое обзорное фото и фото каждого МАФ',()=>{
 assert.match(checkCaptureCompletion({photos:0,maf:1,missing:0},false),/обзорное фото/);
 assert.match(checkCaptureCompletion({photos:1,maf:2,missing:1},false),/каждого/);
 assert.match(checkCaptureCompletion({photos:1,maf:0,missing:0},false),/отсутствие МАФ/);
 assert.equal(checkCaptureCompletion({photos:2,maf:0,missing:0},true),null);
 assert.equal(checkCaptureCompletion({photos:3,maf:2,missing:0},false),null);
});
test('решение разрешено только для переданного объекта; возврат требует причины',()=>{
 assert.throws(()=>captureDecision('accepted','rework','Причина'),{status:409});
 assert.throws(()=>captureDecision('submitted','rework','  '),{status:422});
 assert.deepEqual(captureDecision('submitted','rework','  Переснять  '),{decision:'rework',comment:'Переснять'});
 assert.deepEqual(captureDecision('submitted','accepted',''),{decision:'accepted',comment:''});
});
test('API очередей использует серверное условие и параметры района',async()=>{
 const queries=[];
 const pool={async query(sql,params){queries.push({sql,params});return {rows:[]}}};
 const app=express();app.use(createDpspCaptureRouter({pool}));
 app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
 const server=app.listen(0);
 await new Promise(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  const q=await fetch(url+'/sites?queue=work&district='+encodeURIComponent('Сокол'));
  assert.equal(q.status,200);assert.deepEqual(await q.json(),{sites:[]});
  assert.match(queries[0].sql,/w.state IS NULL OR w.state='rework'/);
  assert.deepEqual(queries[0].params,['Сокол']);
  assert.equal((await fetch(url+'/sites?queue=invalid')).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('рабочий кабинет и приёмка — отдельные страницы, поиск и фильтр статусов удалены',async()=>{
 const work=await readFile(new URL('../../dp-sp-cabinet/index.html',import.meta.url),'utf8');
 const review=await readFile(new URL('../../dp-sp-review/index.html',import.meta.url),'utf8');
 assert.match(work,/data-review="false"/);
 assert.doesNotMatch(work,/id="search"|id="status"/);
 assert.match(review,/data-review="true"/);
 assert.match(review,/Отработанные/);
 assert.match(review,/Принятые/);
});
