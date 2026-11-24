(function cabinet(){
'use strict';
const $=id=>document.getElementById(id);
const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const base='/object-photo-points/dpsp',flow=base+'/workflow';
const API='https://obhod-sao.ru/photo-api';
const review=document.body.dataset.review==='true';
const completionButton=$('openCompletionReport');
const overviewExamples={
 dp:{id:'e636cdbc-942d-569a-a24e-a72901bce1dd',address:'Планетная ул., 18'},
 sp:{id:'a4700409-a480-5281-a571-dd5355f925ea',address:'Балтийская ул., 4'},
};
let token=localStorage.getItem('saoPhotoToken')||localStorage.getItem('sao-photo-token')||'';
const incoming=new URLSearchParams(location.search);
let linkedSite=/^[0-9a-f-]{36}$/i.test(incoming.get('site')||'')?incoming.get('site'):null;
let queue=review?(incoming.get('queue')==='accepted'?'accepted':'review'):'work',rows=[],current=null,types=[],busy=false,listSeq=0,detailSeq=0,urls=[];
const kind=k=>k==='dp'?'Детская площадка':'Спортивная площадка';
let listScroll=0, queueScroll=0, photoTrigger=null, navigationSeq=0;
let siteMap, activeCamera, mapRun=0;
let assignedDistrict='';
const mobileViewport=matchMedia('(max-width: 760px)');
const mobile=()=>mobileViewport.matches;
function showCard(id){
 if(mobile()){
  if(!history.state?.cabinetSite)history.pushState({cabinetSite:id},'');
  else if(history.state.cabinetSite!==id)history.replaceState({cabinetSite:id},'');
 }
 document.body.classList.add('card-open');
 if(mobile()){window.scrollTo(0,0);$('detail').querySelector('h2')?.focus({preventScroll:true});}
}
mobileViewport.addEventListener('change',()=>{
 if(mobile()&&current&&document.body.classList.contains('card-open'))showCard(current.point_id);
});
function showList(){
 ++navigationSeq;
 clearCardMedia();
 document.body.classList.remove('card-open');++detailSeq;
 requestAnimationFrame(()=>{window.scrollTo(0,listScroll);$('queue').scrollTop=queueScroll;
 const selected=[...$('queue').children].find(e=>e.dataset.site===current?.point_id);selected?.focus({preventScroll:true});});
}
window.addEventListener('popstate',()=>{
 ++navigationSeq;
 if(history.state?.cabinetSite){openSite(history.state.cabinetSite,true).catch(e=>message(e.message));}else showList();
});
const conditions={ok:'Исправно',repair:'Требует ремонта',broken:'Неисправно'};
function message(text){$('message').textContent=text||'';}
function clearImages(){for(const url of urls)URL.revokeObjectURL(url);urls=[];}
function loginView(text){
 $('login').hidden=false;$('main').hidden=true;$('top').hidden=true;$('loginMsg').textContent=text||'';
 if(completionButton){$('completionReport').close();completionButton.disabled=true;}
 ++listSeq;
 rows=[];types=[];
 clearDetail();
 message('');
}
function appView(user){
 const admin=user.role==='prefecture_admin';
 const district=user.role==='dpsp_district_editor'&&user.district;
 if(!admin&&(review||!district))throw Error(review?'Приёмка доступна только администратору.':'Нет доступа к кабинету оцифровки ДП/СП.');
 assignedDistrict=admin?'':district;
 document.body.classList.toggle('district-scoped',Boolean(assignedDistrict));
 $('district').closest('.field').hidden=Boolean(assignedDistrict);
 if($('reviewLink'))$('reviewLink').hidden=Boolean(assignedDistrict);
 $('login').hidden=true;$('main').hidden=false;$('top').hidden=false;
 $('userLine').textContent=[user.displayName||user.email,assignedDistrict||'Префектура'].filter(Boolean).join(' · ');
}
async function req(path,opts={}){
 const headers=new Headers(opts.headers||{});
 if(token)headers.set('Authorization','Bearer '+token);
 const res=await fetch(API+path,{...opts,credentials:'include',cache:'no-store',headers});
 if(!res.ok){const data=await res.json().catch(()=>({}));if(res.status===401){token='';localStorage.removeItem('saoPhotoToken');loginView('Войдите повторно.');}throw Error(data.error||data.message||'Ошибка HTTP '+res.status);}
 return res;
}
const api=async(path,opts)=>{const r=await req(path,opts);return r.status===204?{}:r.json();};
const post=(path,body,method='POST')=>api(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const section=(parent,text)=>{const h=make('h3',text,'section');parent.append(h);return h;};
function btn(text,action,cls='btn'){const b=make('button',text,cls);b.type='button';b.onclick=action;return b;}
function field(title,control){const e=make('label',null,'field');e.append(make('span',title),control);control.style.width='100%';return e;}
function options(items){const s=make('select');for(const [value,label] of items){const o=make('option',label);o.value=value;s.append(o);}return s;}
function syncDisabled(){for(const e of $('main').querySelectorAll('button,input,select,textarea')){if(busy){if(!e.disabled){e.disabled=true;e.dataset.captureBusy='1';}}else if(e.dataset.captureBusy){e.disabled=false;delete e.dataset.captureBusy;}}}
async function mutate(action,done,reload=true){
 if(busy)return;busy=true;syncDisabled();message('Сохраняем…');
 const id=current?.point_id, navigation=navigationSeq;
 try{await action();if(reload){await loadQueue();if(navigation!==navigationSeq){message(done);return;}if(id&&rows.some(r=>r.point_id===id))await openSite(id,true);else if(rows.length)await openSite(rows[0].point_id,true);else clearDetail();}message(done);}
 catch(e){
  message(e.message);
  // A failed MAF photo upload may leave a created item; show it before retrying.
  if(!review&&navigation===navigationSeq&&id&&rows.some(r=>r.point_id===id)){
   try{await openSite(id,true);}catch(refreshError){message(e.message+' Не удалось обновить карточку: '+refreshError.message);}
  }
 }
 finally{busy=false;syncDisabled();}
}
async function dictionaries(){
 const d=await api(base+'/dictionaries');types=d.types||[];const select=$('district'),prev=select.value;
 const all=make('option','Все районы');all.value='';
 select.replaceChildren(...(assignedDistrict?[]:[all]));
 for(const row of d.districts||[]){const option=make('option',row.name);option.value=row.name;select.append(option);}
 select.value=assignedDistrict?select.options[0]?.value||'':prev;
 if(completionButton)completionButton.disabled=false;
}
function clearDetail(){document.body.classList.remove('card-open');if(history.state?.cabinetSite)history.replaceState(null,'',location.pathname+location.search);current=null;++detailSeq;clearCardMedia();clearImages();$('detail').replaceChildren(make('div','Выберите площадку','empty'));renderQueue();}
function renderQueue(){
 const list=$('queue');list.replaceChildren();$('queueCount').textContent=rows.length.toLocaleString('ru-RU');
 for(const row of rows){const b=btn('',()=>{if(!busy)openSite(row.point_id).catch(e=>message(e.message));},'item'+(current?.point_id===row.point_id?' active':''));b.dataset.site=row.point_id;b.append(make('strong',row.address||'ID '+row.source_id),make('small',row.district+' · '+kind(row.kind)+' · ID '+row.source_id));list.append(b);}
 if(!rows.length)list.append(make('div',review?'В этом списке пока нет площадок':'Все площадки по выбранным фильтрам отработаны','empty'));
 syncDisabled();
}
async function loadQueue(){
 const seq=++listSeq;const q=new URLSearchParams({queue});
 if(!assignedDistrict&&$('district').value)q.set('district',$('district').value);if($('kind').value)q.set('kind',$('kind').value);
 const data=await api(flow+'/sites?'+q);if(seq!==listSeq)return;rows=data.sites||[];
 if(current&&!rows.some(r=>r.point_id===current.point_id))clearDetail();
 renderQueue();
}
async function resetQueue(){if(busy)return;message('Загружаем список…');clearDetail();try{await loadQueue();message('');if(linkedSite){const id=linkedSite;linkedSite=null;if(rows.some(r=>r.point_id===id))await openSite(id);else message('Площадка уже в другой очереди или недоступна.');}}catch(e){message(e.message);}}
async function openSite(id,allowBusy=false){
 if(busy&&!allowBusy)return;
 if(mobile()&&!document.body.classList.contains('card-open')){listScroll=window.scrollY;queueScroll=$('queue').scrollTop;}
 const seq=++detailSeq;clearCardMedia();clearImages();$('detail').replaceChildren(make('div','Загружаем карточку…','empty'));
 const [d,w]=await Promise.all([api(base+'/sites/'+encodeURIComponent(id)),api(flow+'/sites/'+encodeURIComponent(id))]);
 if(seq!==detailSeq)return;
 current=d.site;
 const map=renderDetail(d,w,seq);
 renderQueue();showCard(id);
 map?.render();
}
function clearCardMedia(){
 closeCamera();
 ++mapRun;
 siteMap?.destroy();
 siteMap=null;
}
function sitePhotoMap(panel,site,frames,seq){
 const select=panel.querySelector('select'),location=panel.querySelector('.map-photo-location');
 for(const frame of frames){
  const option=make('option',frame.label);
  option.value=frame.id;
  select.append(option);
 }
 select.closest('label').hidden=frames.length<2;
 async function render(){
  const run=++mapRun;
  const isCurrent=()=>run===mapRun&&seq===detailSeq&&panel.isConnected&&!$('main').hidden;
  const frame=frames.find(item=>item.id===select.value);
  let shot=null;
  try{
   const {mountReviewMap}=await import('../districts/review-map.mjs');
   if(frame?.blob){
    const {readPhotoLocation}=await import('./photo-location.mjs');
    shot=await readPhotoLocation(frame.blob);
   }
   if(!isCurrent())return;
   const row=shot?.gps
    ?{latitude:shot.gps[0],longitude:shot.gps[1],heading:shot.heading}
    :site;
   const angle=shot?.heading==null?'':' Направление кадра '+Math.round(shot.heading)%360+'°.';
   if(shot?.gps){
    location.textContent='Точка съёмки по GPS.'+(angle||' Направление не записано.');
   }else{
    location.textContent=frame?'Отметка площадки · GPS кадра недоступен.'+angle:'Отметка площадки · снимков пока нет.';
   }
   siteMap?.destroy();
   siteMap=mountReviewMap(panel,row);
  }catch{
   if(isCurrent())panel.querySelector('[data-map="status"]').textContent='Мини-карта недоступна.';
  }
 }
 select.onchange=render;
 return {render,receive(id,blob){
  const frame=frames.find(item=>item.id===id);
  if(!frame)return;
  frame.blob=blob;
  if(select.value===id)render();
 }};
}
async function photo(path,img,seq,onLoad){
 try{const b=await (await req(path)).blob();if(seq!==detailSeq||!img.isConnected)return;const url=URL.createObjectURL(b);urls.push(url);img.src=url;img.onclick=()=>{photoTrigger=img;$('largePhoto').src=url;$('viewer').showModal();};img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','Открыть фото полностью');img.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();img.click();}};onLoad?.(b);}
 catch(e){if(seq===detailSeq&&img.isConnected){img.replaceWith(make('div','Не удалось загрузить фото: '+e.message,'empty'));}}
}
function closeCamera(){
 if(!activeCamera)return;
 const video=$('cameraPreview');
 video.srcObject?.getTracks().forEach(track=>track.stop());
 video.srcObject=null;
 if(activeCamera.watch!=null)navigator.geolocation.clearWatch(activeCamera.watch);
 window.removeEventListener('deviceorientationabsolute',activeCamera.orientation);
 window.removeEventListener('deviceorientation',activeCamera.orientation);
 activeCamera=null;
 $('camera').close();
}
async function openCamera(title,onCapture){
 if(busy||activeCamera)return;
 const video=$('cameraPreview'),snap=$('cameraSnap'),status=$('cameraStatus');
 const session={onCapture};
 activeCamera=session;
 $('cameraTitle').textContent=title;
 snap.disabled=true;
 status.textContent='Включаем камеру…';
 $('camera').showModal();
 try{
  const orientationPermission=window.DeviceOrientationEvent?.requestPermission;
  if(orientationPermission){
   session.compass=orientationPermission.call(window.DeviceOrientationEvent).catch(()=>null);
  }
  if(!navigator.mediaDevices?.getUserMedia)throw Error('Съёмка доступна в браузере с поддержкой камеры по HTTPS.');
  const stream=await navigator.mediaDevices.getUserMedia({
   audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},
  });
  if(activeCamera!==session){stream.getTracks().forEach(track=>track.stop());return;}
  video.srcObject=stream;
  await video.play();
  if(activeCamera!==session)return;
  observeCameraLocation(session);
  status.textContent='';
  snap.disabled=false;
 }catch(error){
  if(activeCamera!==session)return;
  video.srcObject?.getTracks().forEach(track=>track.stop());
  video.srcObject=null;
  const cameraErrors={
   NotAllowedError:'Нет доступа к камере. Разрешите его в браузере и откройте камеру снова.',
   NotFoundError:'Камера не найдена. Откройте кабинет на устройстве с камерой.',
   NotReadableError:'Камера занята или недоступна. Закройте другие приложения с камерой и повторите.',
  };
  status.textContent=cameraErrors[error.name]||(navigator.mediaDevices?.getUserMedia
   ?'Не удалось включить камеру. Откройте её снова.':error.message);
 }
}
function observeCameraLocation(session){
 if(navigator.geolocation){
  session.firstPosition=new Promise(resolve=>{
   session.watch=navigator.geolocation.watchPosition(position=>{
    session.position=position;
    resolve();
   },()=>resolve(),{enableHighAccuracy:true,timeout:6000,maximumAge:0});
  });
 }
 Promise.all([import('./photo-location.mjs'),session.compass]).then(([{cameraDirection},permission])=>{
  if(activeCamera!==session||(session.compass&&permission!=='granted'))return;
  session.orientation=event=>{
   const heading=cameraDirection(event);
   if(heading!=null)session.direction={heading,at:Date.now()};
  };
  window.addEventListener('deviceorientationabsolute',session.orientation);
  window.addEventListener('deviceorientation',session.orientation);
 }).catch(()=>{});
}
async function captureFrame(){
 const session=activeCamera,video=$('cameraPreview'),snap=$('cameraSnap');
 if(!session||snap.disabled)return;
 snap.disabled=true;
 try{
  if(!video.videoWidth||!video.videoHeight||!video.srcObject?.getVideoTracks().some(track=>track.readyState==='live')){
   throw Error('Камера недоступна. Откройте её снова.');
  }
  const canvas=make('canvas');
  const capturedAt=Date.now();
  const heading=session.direction&&capturedAt-session.direction.at<2000?session.direction.heading:null;
  const scale=Math.min(1,2400/Math.max(video.videoWidth,video.videoHeight));
  canvas.width=Math.round(video.videoWidth*scale);
  canvas.height=Math.round(video.videoHeight*scale);
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  let blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.84));
  if(activeCamera!==session)return;
  if(!blob)throw Error('Не удалось сохранить кадр. Попробуйте снять ещё раз.');
  if(!session.position&&session.firstPosition){
   $('cameraStatus').textContent='Определяем место съёмки…';
   await Promise.race([session.firstPosition,new Promise(resolve=>setTimeout(resolve,3500))]);
  }
  if(activeCamera!==session)return;
  const position=session.position;
  const gps=position&&Math.abs(capturedAt-position.timestamp)<20000
   ?[position.coords.latitude,position.coords.longitude]:null;
  if(gps||heading!=null){
   const {embedPhotoLocation}=await import('./photo-location.mjs');
   if(activeCamera!==session)return;
   blob=embedPhotoLocation(blob,gps,heading);
  }
  if(blob.size>5*1024*1024)throw Error('Не удалось сохранить кадр. Попробуйте снять ещё раз.');
  const file=new File([blob],'photo-'+capturedAt+'.jpg',{type:'image/jpeg'});
  closeCamera();
  session.onCapture(file);
 }catch(error){
  if(activeCamera!==session)return;
  $('cameraStatus').textContent=error.message;
  snap.disabled=false;
 }
}
function cameraButton(text,title,onCapture,cls='btn'){
 const control=btn(text,()=>openCamera(title,onCapture),cls);
 const icon=make('img',null,'camera-icon');
 icon.src='../dp-sp-cabinet/icons/camera.svg';
 icon.alt='';
 control.prepend(icon);
 return control;
}
function sendPhoto(path,file){return api(path,{method:'PUT',headers:{'Content-Type':file.type,'X-Photo-Filename':encodeURIComponent(file.name)},body:file});}
function mafForm(item,id){
 const form=make('form',null,'maf-form');
 const type=options(types.map(t=>[t.code,t.label]));
 const qty=make('input');qty.type='number';qty.min='1';qty.max='999';qty.required=true;qty.value=String(item?.quantity||1);
 const cond=options(Object.entries(conditions));cond.value=item?.condition||'ok';
 const comment=make('input');comment.maxLength=2000;comment.value=item?.comment||'';
 let capturedPhoto;
 if(item)type.value=item.type_code;
 form.append(field('Тип МАФ',type),field('Количество',qty),field('Состояние',cond),field('Комментарий',comment));
 const submit=make('button',item?'Сохранить':'Добавить МАФ','btn primary');submit.type='submit';form.append(submit);
 if(!item){
  submit.disabled=true;
  const capture=make('div',null,'maf-capture');
  const status=make('span');status.setAttribute('role','status');
  const camera=cameraButton('Снять МАФ','Фото МАФ',file=>{
   capturedPhoto=file;
   status.textContent='Кадр готов';
   camera.lastChild.textContent='Переснять МАФ';
   submit.disabled=false;
  });
  capture.append(camera,status);
  submit.before(capture);
 }
 form.onsubmit=e=>{e.preventDefault();const body={type_code:type.value,quantity:Number(qty.value),condition:cond.value,comment:comment.value};
  if(!item&&!capturedPhoto)return;
  mutate(async()=>{if(item){await post(base+'/maf/'+item.id,body,'PATCH');}
   else{const created=await post(base+'/sites/'+id+'/maf',body);
    try{await sendPhoto(base+'/maf/'+created.id+'/photo',capturedPhoto);}
    catch(err){throw Error('МАФ сохранён, но фото не загружено. Добавьте кадр к его карточке: '+err.message);}
   }},item?'МАФ обновлён':'МАФ и фотография сохранены');
 };return form;
}
function renderDetail(d,w,seq){
 const s=d.site,id=s.point_id,detail=$('detail'),items=d.items||[],photos=w.photos||[];
 const writable=!review&&(!w.workflow||w.workflow.state==='rework');
 detail.replaceChildren(make('h2',s.address||'ID '+s.source_id),make('p',s.district+' · '+kind(s.kind)+' · ID '+s.source_id,'sub'));
 detail.querySelector('h2').tabIndex=-1;
 const states={submitted:'На приёмке',accepted:'Принято',rework:'На доработке'};const state=make('p',states[w.workflow?.state]||'В работе','badge');
 const back=btn('К списку',()=>{if(history.state?.cabinetSite)history.back();else showList();},'btn mobile-back');const backIcon=make('img');backIcon.src='../dp-sp-cabinet/icons/back.svg';backIcon.alt='';backIcon.setAttribute('aria-hidden','true');back.prepend(backIcon);$('top').querySelector('.mobile-back')?.remove();$('top').prepend(back);
 detail.append(state);
 if(review&&s.district_slug){
  const districtLink=make('a','Открыть на карте района','btn');
  districtLink.href='../districts/'+encodeURIComponent(s.district_slug)+'.html?playground='+encodeURIComponent(id);
  districtLink.target='_blank';
  districtLink.rel='noopener';
  const actions=make('div',null,'site-actions');
  actions.append(districtLink);
  detail.append(actions);
 }
 if(w.workflow?.state==='rework')detail.append(make('div','На доработку: '+w.workflow.review_comment,'reason'));
 const overview=make('div',null,'overview-block');
 let map;
 if(review)detail.append(overview);
 else {
  const top=make('div',null,'capture-top');
  const panel=$('siteMapTemplate').content.firstElementChild.cloneNode(true);
  top.append(overview,panel);
  detail.append(top);
  const frames=photos.map((item,index)=>({id:'overview:'+item.id,label:'Обзорное фото '+(index+1)})).reverse();
  for(const item of items){
   if(item.photo_id)frames.push({id:'maf:'+item.id,label:'МАФ · '+item.type_label});
  }
  map=sitePhotoMap(panel,s,frames,seq);
 }
 section(overview,'Обзорные фото · '+photos.length);
 if(writable){
  overview.append(cameraButton('Снять обзорное фото','Обзорное фото площадки',
   file=>mutate(()=>sendPhoto(flow+'/sites/'+id+'/photos',file),'Обзорное фото сохранено'),'btn primary overview-capture'));
  const example=overviewExamples[s.kind];
  if(example){
   const figure=make('figure',null,'overview-example');
   const img=make('img');
   img.alt='Пример общего плана: '+kind(s.kind).toLowerCase();
   const caption=make('figcaption');
   caption.append(make('strong','Образец обзорного фото'),
    make('p',assignedDistrict?'Первый обход':example.address+' · первый обход','sub'),
    make('p','Снимите площадку горизонтально с края. В кадре должны быть видны границы площадки, покрытие и оборудование.'));
   figure.append(img,caption);
   overview.append(figure);
   photo(assignedDistrict?base+'/examples/'+s.kind:'/object-photo-points/playgrounds/'+example.id+'/photo',img,seq);
  }
 }
 const gallery=make('div',null,review?'gallery':'gallery capture-gallery');
 (review?overview:detail).append(gallery);
 for(const item of photos){const box=make('figure');const img=make('img',null,'site-image');img.alt='Обзор площадки';box.append(img,make('figcaption',item.photo_filename));if(writable)box.append(btn('Убрать фото',()=>{if(confirm('Убрать этот кадр из текущей оцифровки?'))mutate(()=>api(flow+'/sites/'+id+'/photos/'+item.id,{method:'DELETE'}),'Фотография убрана');},'btn mini danger'));gallery.append(box);photo(flow+'/sites/'+id+'/photos/'+item.id,img,seq,blob=>map?.receive('overview:'+item.id,blob));}
 if(!photos.length&&!writable)overview.append(make('p','Обзорные фото пока отсутствуют.','sub'));
 section(detail,'Обнаруженные МАФ ('+items.length+')');
 if(writable){
  const add=make('details',null,'add-maf'),summary=make('summary','Добавить МАФ');
  add.open=true;
  add.append(summary,mafForm(null,id));
  detail.append(add);
 }
 for(const item of items){
  const row=make('div',null,'maf-item'),body=make('div',null,'maf-body');
  if(item.photo_id){const img=make('img',null,'maf-photo');img.alt='Фото МАФ';row.append(img);photo(flow+'/maf/'+item.id+'/photo',img,seq,blob=>map?.receive('maf:'+item.id,blob));}
  else row.append(make('div','Нет фото','maf-photo placeholder'));
  body.append(make('b',item.type_label+' × '+item.quantity),make('div',conditions[item.condition]||item.condition,'meta'));if(item.comment)body.append(make('p',item.comment,'comment'));
  if(writable){
   const controls=make('div',null,'maf-actions'),edit=make('div');
   controls.append(cameraButton(item.photo_id?'Переснять МАФ':'Снять МАФ','Фото МАФ',
    file=>mutate(()=>sendPhoto(base+'/maf/'+item.id+'/photo',file),'Фото МАФ сохранено'),'btn mini'),
    btn('Изменить',()=>{if(edit.childNodes.length)edit.replaceChildren();else edit.append(mafForm(item,id));},'btn mini'),
    btn('Убрать МАФ',()=>{if(confirm('Убрать МАФ из текущей оцифровки?'))mutate(()=>api(base+'/maf/'+item.id,{method:'DELETE'}),'МАФ убран');},'btn mini danger'));
   body.append(controls,edit);
  }
  row.append(body);detail.append(row);
 }
 if(!items.length&&!writable)detail.append(make('p','МАФ не добавлены.','sub'));
 if(writable){section(detail,'Завершение оцифровки');
  const noMaf=make('input');noMaf.type='checkbox';
  if(!items.length){const label=make('label',null,'no-maf');label.append(noMaf,document.createTextNode('На площадке нет МАФ'));detail.append(label);}
  const finish=btn('Отправить на приёмку',()=>mutate(()=>post(flow+'/sites/'+id+'/submit',{noMaf:noMaf.checked}),'Объект передан на приёмку'),'btn primary');
  const block=make('div',null,'buttons submit-actions');block.append(finish);detail.append(block,make('p','Для завершения нужен новый общий снимок и фото каждого внесённого МАФ.','sub'));
 }else if(review&&w.workflow?.state==='submitted'){
  section(detail,'Решение по объекту');const comment=make('textarea',null,'review-text');comment.placeholder='Причина возврата (обязательно для доработки)';comment.maxLength=2000;comment.setAttribute('aria-label','Причина возврата на доработку');
  const block=make('div',null,'buttons');block.append(btn('Принять объект',()=>mutate(()=>post(flow+'/sites/'+id+'/decision',{decision:'accepted',comment:comment.value}),'Объект принят'),'btn primary'),
  btn('Вернуть на доработку',()=>{if(!comment.value.trim()){message('Укажите причину возврата.');comment.focus();return;}mutate(()=>post(flow+'/sites/'+id+'/decision',{decision:'rework',comment:comment.value}),'Объект возвращён в рабочий список');},'btn danger'));detail.append(comment,block);
 }else if(review&&w.workflow?.state==='accepted'){detail.append(make('p','Объект принят.','checked-note'));}
 syncDisabled();
 return map;
}
$('loginForm').onsubmit=async e=>{e.preventDefault();try{const res=await fetch(API+'/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:$('email').value,email:$('email').value,password:$('password').value})});const d=await res.json();if(!res.ok||!d.token)throw Error(d.error||d.message||'Не удалось войти');token=d.token;localStorage.setItem('saoPhotoToken',token);appView(d.user||{});await dictionaries();await resetQueue();}catch(e){loginView(e.message);}};
$('logout').onclick=async()=>{try{await req('/auth/logout',{method:'POST'});}catch{}token='';localStorage.removeItem('saoPhotoToken');localStorage.removeItem('sao-photo-token');clearDetail();loginView();};
$('refresh').onclick=resetQueue;$('district').onchange=resetQueue;$('kind').onchange=resetQueue;
if(review){$('reviewQueue').classList.toggle('primary',queue==='review');$('acceptedQueue').classList.toggle('primary',queue==='accepted');const setQueue=q=>{if(busy)return;queue=q;$('reviewQueue').classList.toggle('primary',q==='review');$('acceptedQueue').classList.toggle('primary',q==='accepted');resetQueue();};$('reviewQueue').onclick=()=>setQueue('review');$('acceptedQueue').onclick=()=>setQueue('accepted');}
if(completionButton){
 let completionReport;
 completionButton.onclick=async()=>{
  try{
   const { initCompletionReport }=await import('../dp-sp-review/completion-report.mjs?v=20261124');
   if($('main').hidden||busy)return;
   completionReport??=initCompletionReport({
    dialog:$('completionReport'),
    getDistricts:()=>[...$('district').options].map(option=>option.value).filter(Boolean),
    getSnapshot:signal=>api(flow+'/sheet.json',{signal}),
   });
   completionReport();
  }catch(e){message('Не удалось открыть сводку. '+e.message);}
 };
}
$('closeViewer').onclick=()=>$('viewer').close();$('viewer').onclose=()=>{$('largePhoto').removeAttribute('src');if(photoTrigger?.isConnected)photoTrigger.focus();};
if(!review){
 $('cameraCancel').onclick=closeCamera;
 $('cameraSnap').onclick=captureFrame;
 $('camera').oncancel=event=>{event.preventDefault();closeCamera();};
 window.addEventListener('pagehide',closeCamera);
}
(async()=>{try{if(!token){loginView();return;}const d=await api('/auth/me');appView(d.user||{});await dictionaries();await resetQueue();}catch(e){loginView(e.message);}})();
})();
