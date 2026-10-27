import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('../../districts/playground-photo-layer.js',import.meta.url),'utf8');
function fake(){
 const events={},nodes=[],markers=[],requests=[];
 class El{constructor(tag='div'){this.tag=tag;this.children=[];this.classList={add(){},remove(){},toggle(){},contains(){return true}};this.style={};this.isConnected=true;this.files=[];this.attributes={}}set innerHTML(v){this.html=v;if(this.tag==='container'){this.input=new El('checkbox');this.input.closest=()=>({classList:this.classList});this.count=new El();this.message=new El()}if(this.tag==='card'){this.photo=new El();this.controls=new El();this.status=new El()}}get innerHTML(){return this.html}querySelector(sel){return {'input':this.input,'[data-count]':this.count,'[data-message]':this.message,'.pg-photo':this.photo,'.pg-controls':this.controls,'.pg-status':this.status}[sel]}setAttribute(k,v){this.attributes[k]=v}addEventListener(k,fn){this['on'+k]=fn}append(...a){this.children.push(...a)}appendChild(a){this.children.push(a)}}
 const container=new El('container'),card=new El('card'),document={getElementById:id=>id==='card'?card:container,createElement:tag=>{let x=new El(tag);nodes.push(x);return x}};
 const map={addChild(m){markers.push(m)},removeChild(m){markers.splice(markers.indexOf(m),1)}},window={ymaps3:{YMapMarker:class{constructor(options,el){this.options=options;this.el=el}}}};
 const point={id:'p1',kind:'dp',address:'Тест',source_id:'5',longitude:37.5,latitude:55.8,photo_state:'empty'};
 async function apiRequest(url,options){requests.push({url,options});return {json:async()=>({points:[point]}),blob:async()=>new Blob([])}}
 vm.runInNewContext(script,{window,document,URL,Blob,encodeURIComponent,console});
 let layer=window.initPlaygroundPhotoLayer({map,district:'Аэропорт',apiRequest,getUser:()=>({role:'district_editor',district:'Аэропорт'}),preparePointPhoto:async f=>f,escapeHtml:x=>String(x)});
 return {container,card,markers,requests,point,layer}
}
test('слой загружается отдельно и выключается без удаления других данных',async()=>{let x=fake();x.container.input.checked=true;await x.container.input.onchange();assert.equal(x.markers.length,1);assert.match(x.requests[0].url,/playgrounds\/public/);x.container.input.checked=false;await x.container.input.onchange();assert.equal(x.markers.length,0)});
test('карточка площадки открывает один фотослот района',async()=>{let x=fake();x.container.input.checked=true;await x.container.input.onchange();await x.markers[0].el.onclick({stopPropagation(){}});assert.match(x.card.html,/Детская площадка/);assert.equal(x.card.controls.children.length,2)});
