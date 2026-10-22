const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function element(){return {value:'',textContent:'',hidden:false,disabled:false,children:[],dataset:{},classList:{toggle(){},remove(){}},append(...x){this.children.push(...x)},prepend(...x){this.children.unshift(...x)},replaceChildren(...x){this.children=x;this.textContent=''},focus(){},setAttribute(){}};}
function page({count=2,fail=false,district='',kind='',queueFail=false,slots=1,failAt=0}={}){
 const elements=new Map(), get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};
 const objects=Array.from({length:count},(_,i)=>({id:'o'+i,label:'Object '+i,group:i===1?'Other':'District',kind:'tpu',type:'TPU',required:1}));
 objects.forEach(o=>o.required=slots);
 const photos=objects.flatMap((o,i)=>Array.from({length:slots},(_,j)=>({id:'p'+i+'s'+j,objectId:o.id,slot:j+1,status:'pending',uploaded_at:'2026-10-20'})));
 const tabs=['pending','rework'].map(tab=>Object.assign(element(),{dataset:{tab}}));
 let writes=0, queueReads=0;
 const api={user:()=>({role:'prefecture_admin'}),request:async(url,options)=>{
  if(url.endsWith('/queue')){if(queueFail && queueReads++>0)throw Error('queue offline');return {json:async()=>({pending:photos.filter(p=>p.status==='pending').map(p=>({...p,object:objects.find(o=>o.id===p.objectId)})),rework:[],counts:{}})}};
  if(options?.method==='POST'){writes++;if(fail || writes===failAt)throw Error('offline');const i=photos.findIndex(p=>url.includes('/'+p.id+'/'));photos[i].status=JSON.parse(options.body).decision;return {json:async()=>({})}};
  const o=objects.find(o=>url.endsWith('/objects/'+o.id));
  if(o){const own=photos.filter(p=>p.objectId===o.id);return {json:async()=>({status:own.some(p=>p.status==='pending')?'review':'closed',accepted:own.filter(p=>p.status==='accepted').length,required:slots,slots:own.map(photo=>({slot:photo.slot,photo:photo.status==='rejected'?null:photo}))})}};
  return {blob:async()=>({})};
 }};
 const context={window:{TpuPhotoApi:api,scrollTo(){},addEventListener(){}},document:{getElementById:get,createElement:element,querySelectorAll:selector=>selector==='.tab'?tabs:[get('acceptObject'),get('nextObject'),get('backToList')]},Option:function(text,value){return {textContent:text,value}},URL:{createObjectURL:()=>'',revokeObjectURL(){}},confirm:()=>true,setTimeout,console};
 vm.createContext(context);const html=fs.readFileSync(__dirname+'/tpu-review.html','utf8');
 vm.runInContext(html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>')),context);
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 return {get,tick,writes:()=>writes,async start(){await tick();get('districtFilter').value=district;get('kindFilter').value=kind;await get('list').children[0].onclick()},async accept(){const card=get('slotGrid').children[0];await card.children[1].children[2].children[0].onclick();await tick()}};
}
test('после последнего принятого фото открывается следующий объект',async()=>{const p=page();await p.start();await p.accept();assert.equal(p.get('objectTitle').textContent,'Object 1');});
test('после конца очереди показан результат',async()=>{const p=page({count:1});await p.start();await p.accept();assert.equal(p.get('objectView').hidden,true);assert.match(p.get('listStatus').textContent,/проверены/);});
test('ошибка сохранения оставляет текущий объект',async()=>{const p=page({fail:true});await p.start();await p.accept();assert.equal(p.get('objectTitle').textContent,'Object 0');assert.match(p.get('objectStatus').textContent,/offline/);});
test('поток сохраняет район и вид объекта',async()=>{const p=page({district:'District',kind:'tpu'});await p.start();await p.accept();assert.equal(p.get('objectView').hidden,true);assert.equal(p.get('districtFilter').value,'District');assert.equal(p.get('kindFilter').value,'tpu');});
test('ошибка очереди после сохранения не маскируется завершением',async()=>{const p=page({queueFail:true});await p.start();await p.accept();assert.equal(p.get('objectView').hidden,false);assert.match(p.get('objectStatus').textContent,/queue offline/);assert.equal(p.writes(),1);});

test('пока остались непроверенные фото, объект не переключается',async()=>{const p=page({slots:2});await p.start();await p.accept();assert.equal(p.get('objectTitle').textContent,'Object 0');assert.equal(p.writes(),1);});
test('массовая приёмка переключает объект после всех сохранений',async()=>{const p=page({slots:2});await p.start();await p.get('acceptObject').onclick();assert.equal(p.get('objectTitle').textContent,'Object 1');assert.equal(p.writes(),2);});
test('частичный сбой массовой приёмки остаётся видимым',async()=>{const p=page({slots:2,failAt:2});await p.start();await p.get('acceptObject').onclick();assert.equal(p.get('objectTitle').textContent,'Object 0');assert.match(p.get('objectStatus').textContent,/offline/);assert.equal(p.get('acceptObject').hidden,false);await p.get('acceptObject').onclick();assert.equal(p.get('objectTitle').textContent,'Object 1');});
test('повторный клик не отправляет второе решение',async()=>{const p=page();await p.start();await Promise.all([p.accept(),p.accept()]);assert.equal(p.writes(),1);});
test('отклонение последнего фото тоже продолжает поток',async()=>{const p=page();await p.start();const body=p.get('slotGrid').children[0].children[1];const form=body.children[3];form.children[0].value='Исправить ракурс';await form.onsubmit({preventDefault(){}});await p.tick();assert.equal(p.get('objectTitle').textContent,'Object 1');});
