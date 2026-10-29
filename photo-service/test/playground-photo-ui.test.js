import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('../../districts/playground-photo-layer.js',import.meta.url),'utf8');
function fake(){
 const events={},nodes=[],markers=[],requests=[];
 class El{constructor(tag='div'){this.tag=tag;this.children=[];this.classList={add(){},remove(){},toggle(){},contains(){return true}};this.style={};this.isConnected=true;this.files=[];this.attributes={}}set innerHTML(v){this.html=v;if(this.tag==='container'){this.input=new El('checkbox');this.input.closest=()=>({classList:this.classList});this.count=new El();this.message=new El()}if(this.tag==='card'){this.photo=new El();this.controls=new El();this.status=new El()}}get innerHTML(){return this.html}querySelector(sel){return {'input':this.input,'[data-count]':this.count,'[data-message]':this.message,'.pg-photo':this.photo,'.pg-controls':this.controls,'.pg-status':this.status}[sel]}setAttribute(k,v){this.attributes[k]=v}addEventListener(k,fn){this['on'+k]=fn}append(...a){this.children.push(...a)}appendChild(a){this.children.push(a)}}
 const container=new El('container'),card=new El('card'),document={getElementById:id=>id==='card'?card:container,createElement:tag=>{let x=new El(tag);nodes.push(x);return x}};
 const map={zoom:14,update(options){this.lastUpdate=options},addChild(m){markers.push(m)},removeChild(m){markers.splice(markers.indexOf(m),1)}},window={ymaps3:{YMapMarker:class{constructor(options,el){this.options=options;this.el=el}}}};
 const point={id:'p1',kind:'dp',address:'Тест',source_id:'5',longitude:37.5,latitude:55.8,photo_state:'empty'};
 async function apiRequest(url,options){requests.push({url,options});return {json:async()=>({points:[point]}),blob:async()=>new Blob([])}}
 vm.runInNewContext(script,{window,document,URL,Blob,encodeURIComponent,console});
 const popover={opened:[],open(options){this.opened.push(options)}};
 const centerSelection=(center)=>map.update({location:{center,zoom:map.zoom},duration:300});
 let layer=window.initPlaygroundPhotoLayer({map,district:'Аэропорт',apiRequest,getUser:()=>({role:'district_editor',district:'Аэропорт'}),preparePointPhoto:async f=>f,escapeHtml:x=>String(x),centerSelection,popover});
 return {container,card,markers,requests,point,layer,map,popover}
}
test('слой загружается отдельно и выключается без удаления других данных',async()=>{let x=fake();x.container.input.checked=true;await x.container.input.onchange();assert.equal(x.markers.length,1);assert.match(x.requests[0].url,/playgrounds\/public/);x.container.input.checked=false;await x.container.input.onchange();assert.equal(x.markers.length,0)});
test('карточка площадки открывает один фотослот района',async()=>{let x=fake();x.container.input.checked=true;await x.container.input.onchange();await x.markers[0].el.onclick({stopPropagation(){}});assert.equal(JSON.stringify(x.popover.opened.at(-1)),JSON.stringify({coordinates:[37.5,55.8],kind:'dp',title:'Тест',subtitle:'ID в таблице 5'}));assert.match(x.card.html,/Фото/);assert.equal(x.card.controls.children.length,3);assert.deepEqual(Array.from(x.map.lastUpdate.location.center),[37.5,55.8]);assert.equal(x.map.lastUpdate.location.zoom,14)});
test('цвет точки отражает статус фото и обновляется после изменения статуса',async()=>{
 const x=fake();x.container.input.checked=true;await x.container.input.onchange();
 for(const [state,color] of [['empty','#808080'],['pending','#f2c200'],['rework','#d93025'],['accepted','#16834c']]){
  x.point.photo_state=state;await x.layer.refresh();
  assert.equal(x.markers[0].el.style.background,color);
  assert.equal(x.markers[0].el.className,'pg-pin','круглая точка с увеличенной зоной клика — .pg-pin в point-popover.css');
 }
});

test('единое управление показывает только выбранный вид площадок',async()=>{
 const x=fake();
 await x.layer.setKind('dp',true);
 assert.equal(x.markers.length,1);
 await x.layer.setKind('dp',false);
 assert.equal(x.markers.length,0);
 await x.layer.setKind('sp',true);
 assert.equal(x.markers.length,0);
});

test('фотослой работает независимо от выбора видов площадок',async()=>{
 const x=fake();
 await x.layer.setKind('sp',true);
 assert.equal(x.markers.length,0);
 x.container.input.checked=true;
 await x.container.input.onchange();
 assert.equal(x.markers.length,1);
 await x.layer.setKind('sp',false);
 assert.equal(x.markers.length,1);
 x.container.input.checked=false;
 await x.container.input.onchange();
 assert.equal(x.markers.length,0);
});
