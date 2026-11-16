import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../../dev/templates/dpsp-sheet.gs',import.meta.url),'utf8');
const context=vm.createContext({Utilities:{formatDate:date=>date.toISOString()}});
vm.runInContext(source,context);
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const site=(n,state,photoCount=0,mafCount=0)=>({point_id:id(n),source_id:String(n),district:'Сокол',kind:'dp',address:'Тест',state,capture_count:photoCount,maf_count:mafCount});
const fixture=()=>({generated_at:'2026-11-16T10:00:00Z',sites:[site(1,'work'),site(2,'submitted',2,1),site(3,'accepted'),site(4,'rework')],photos:[
 {photo_id:id(11),point_id:id(2),photo_token:'a'.repeat(32)},
 {photo_id:id(12),point_id:id(2),photo_token:'b'.repeat(32)}],
 maf:[{maf_id:id(21),point_id:id(2),quantity:3,condition:'ok',type_label:'Качели',photo_id:id(22),photo_token:'c'.repeat(32)}]});
const dict={districts:[{name:'Сокол',slug:'sokol'},{name:'Коптево',slug:'koptevo'}]};
const local=v=>JSON.parse(JSON.stringify(v));
test('новая таблица: очереди, все общие кадры, родительские ID и свод согласованы',()=>{
 const out=context.captureBuild(fixture(),dict);
 assert.equal(out.all.rows.length,4);
 assert.deepEqual(['work','submitted','accepted','rework'].map(k=>out[k].rows.length),[1,1,1,1]);
 assert.equal(out.photos.rows.length,2);assert.equal(out.maf.rows.length,1);
 assert.equal(out.photos.rows[0][12],id(2));assert.equal(out.maf.rows[0][14],id(2));
 assert.equal(out.photos.rows[0][13],id(11));assert.equal(out.photos.rows[1][13],id(12));
 assert.match(out.photos.images[0],/capture-thumb\/a{32}\.jpg/);
 assert.match(out.maf.images[0],/photo-thumb\/c{32}\.jpg/);
 assert.match(out.submitted.links[15][0].url,/dp-sp-review\/\?site=/);
 assert.match(out.accepted.links[15][0].url,/&queue=accepted$/);
 assert.match(out.rework.links[15][0].url,/dp-sp-cabinet\/\?site=/);
 assert.match(out.photos.links[11][0].url,/districts\/sokol\.html\?playground=/);
 assert.deepEqual(local(out.summary.at(-1)),['ИТОГО',4,1,1,1,1,2,.5,2,1,3,1]);
 assert.deepEqual(local(out.summary.find(row=>row[0]==='Коптево')),['Коптево',0,0,0,0,0,0,0,0,0,0,0]);
});
test('пересборка отклоняет потерянные связи, дубли и неполный срез',()=>{
 let d=fixture();d.photos.pop();assert.throws(()=>context.captureBuild(d,dict),/Несогласованные/);
 d=fixture();d.maf[0].point_id=id(999);assert.throws(()=>context.captureBuild(d,dict),/потерянная связь/);
 d=fixture();d.sites.push(d.sites[0]);assert.throws(()=>context.captureBuild(d,dict),/Повтор/);
 assert.throws(()=>context.captureBuild({sites:[]},dict),/полный срез/);
});
test('имена нового цикла не перезаписывают прежние вкладки, формулы из адресов экранируются',()=>{
 const names=Object.values(context.CAPTURE.names);
 for(const s of ['Свод','Площадки','МАФ','Сверка','Журнал','_state'])assert.ok(!names.includes(s));
 assert.equal(context.captureText('=1+1'),"'=1+1");
 assert.equal(context.capturePreview('bad-token',false),'');
 assert.match(source,/function syncSheet\(\)[\s\S]*?fetchJson\('\/workflow\/sheet\.json'\)/);
});
