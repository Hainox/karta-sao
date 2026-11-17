(function cabinet(){
'use strict';
const $=id=>document.getElementById(id);
const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const base='/object-photo-points/dpsp',flow=base+'/workflow';
const API='https://obhod-sao.ru/photo-api';
const review=document.body.dataset.review==='true';
let token=localStorage.getItem('saoPhotoToken')||localStorage.getItem('sao-photo-token')||'';
const incoming=new URLSearchParams(location.search);
let linkedSite=/^[0-9a-f-]{36}$/i.test(incoming.get('site')||'')?incoming.get('site'):null;
let queue=review?(incoming.get('queue')==='accepted'?'accepted':'review'):'work',rows=[],current=null,types=[],busy=false,listSeq=0,detailSeq=0,urls=[];
const kind=k=>k==='dp'?'Детская площадка':'Спортивная площадка';
let listScroll=0, queueScroll=0, photoTrigger=null, navigationSeq=0;
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
function loginView(text){$('login').hidden=false;$('main').hidden=true;$('top').hidden=true;$('loginMsg').textContent=text||'';clearImages();}
function appView(user){if(user.role!=='prefecture_admin')throw Error('Доступ только для префектуры.');$('login').hidden=true;$('main').hidden=false;$('top').hidden=false;$('userLine').textContent=(user.displayName||user.email||'')+' · Префектура';}
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
 for(const row of d.districts||[]){const option=make('option',row.name);option.value=row.name;select.append(option);}select.value=prev;
}
function clearDetail(){document.body.classList.remove('card-open');if(history.state?.cabinetSite)history.replaceState(null,'',location.pathname+location.search);current=null;++detailSeq;clearImages();$('detail').replaceChildren(make('div','Выберите площадку','empty'));renderQueue();}
function renderQueue(){
 const list=$('queue');list.replaceChildren();$('queueCount').textContent=rows.length.toLocaleString('ru-RU');
 for(const row of rows){const b=btn('',()=>{if(!busy)openSite(row.point_id).catch(e=>message(e.message));},'item'+(current?.point_id===row.point_id?' active':''));b.dataset.site=row.point_id;b.append(make('strong',row.address||'ID '+row.source_id),make('small',row.district+' · '+kind(row.kind)+' · ID '+row.source_id));list.append(b);}
 if(!rows.length)list.append(make('div',review?'В этом списке пока нет площадок':'Все площадки по выбранным фильтрам отработаны','empty'));
 syncDisabled();
}
async function loadQueue(){
 const seq=++listSeq;const q=new URLSearchParams({queue});
 if($('district').value)q.set('district',$('district').value);if($('kind').value)q.set('kind',$('kind').value);
 const data=await api(flow+'/sites?'+q);if(seq!==listSeq)return;rows=data.sites||[];
 if(current&&!rows.some(r=>r.point_id===current.point_id))clearDetail();
 renderQueue();
}
async function resetQueue(){if(busy)return;message('Загружаем список…');clearDetail();try{await loadQueue();message('');if(linkedSite){const id=linkedSite;linkedSite=null;if(rows.some(r=>r.point_id===id))await openSite(id);else message('Площадка уже в другой очереди или недоступна.');}}catch(e){message(e.message);}}
async function openSite(id,allowBusy=false){
 if(busy&&!allowBusy)return;
 if(mobile()&&!document.body.classList.contains('card-open')){listScroll=window.scrollY;queueScroll=$('queue').scrollTop;}
 const seq=++detailSeq;clearImages();$('detail').replaceChildren(make('div','Загружаем карточку…','empty'));
 const [d,w]=await Promise.all([api(base+'/sites/'+encodeURIComponent(id)),api(flow+'/sites/'+encodeURIComponent(id))]);
 if(seq!==detailSeq)return;current=d.site;renderDetail(d,w,seq);renderQueue();showCard(id);
}
async function photo(path,img,seq){
 try{const b=await (await req(path)).blob();if(seq!==detailSeq||!img.isConnected)return;const url=URL.createObjectURL(b);urls.push(url);img.src=url;img.onclick=()=>{photoTrigger=img;$('largePhoto').src=url;$('viewer').showModal();};img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','Открыть фото полностью');img.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();img.click();}};}
 catch(e){if(seq===detailSeq&&img.isConnected){img.replaceWith(make('div','Не удалось загрузить фото: '+e.message,'empty'));}}
}
async function prepare(file){
 if(['image/jpeg','image/png','image/webp'].includes(file.type)&&file.size<=5*1024*1024)return file;
 if(!file.type.startsWith('image/'))throw Error('Выберите изображение JPEG, PNG или WebP.');
 let bitmap;
 try{bitmap=await createImageBitmap(file);}catch{throw Error('Не удалось прочитать изображение. Используйте JPEG или PNG.');}
 try{const ratio=Math.min(1,2400/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.84));
  if(!blob||blob.size>5*1024*1024)throw Error('Фото превышает 5 МБ после сжатия.');
  return new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'});
 }finally{bitmap.close();}
}
async function sendPhoto(path,file){const f=await prepare(file);return api(path,{method:'PUT',headers:{'Content-Type':f.type,'X-Photo-Filename':encodeURIComponent(f.name)},body:f});}
function uploadInput(multiple=false){const e=make('input');e.type='file';e.accept='image/jpeg,image/png,image/webp';e.multiple=multiple;return e;}
function mafForm(item,id){
 const form=make('form',null,'maf-form');
 const type=options(types.map(t=>[t.code,t.label]));
 const qty=make('input');qty.type='number';qty.min='1';qty.max='999';qty.required=true;qty.value=String(item?.quantity||1);
 const cond=options(Object.entries(conditions));cond.value=item?.condition||'ok';
 const comment=make('input');comment.maxLength=2000;comment.value=item?.comment||'';
 const file=uploadInput();if(item)type.value=item.type_code;
 form.append(field('Тип МАФ',type),field('Количество',qty),field('Состояние',cond),field('Комментарий',comment));
 if(!item){file.required=true;form.append(field('Фото МАФ',file));}
 const submit=make('button',item?'Сохранить':'Добавить МАФ','btn primary');submit.type='submit';form.append(submit);
 form.onsubmit=e=>{e.preventDefault();const body={type_code:type.value,quantity:Number(qty.value),condition:cond.value,comment:comment.value};
  const selected=file.files[0];
  mutate(async()=>{if(item){await post(base+'/maf/'+item.id,body,'PATCH');}
   else{const prepared=await prepare(selected);const created=await post(base+'/sites/'+id+'/maf',body);
    try{await sendPhoto(base+'/maf/'+created.id+'/photo',prepared);}
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
 const actions=make('div',null,'site-actions');
 if(s.district_slug){const a=make('a','Открыть на карте района','btn');a.href='../districts/'+encodeURIComponent(s.district_slug)+'.html?playground='+encodeURIComponent(id);a.target='_blank';a.rel='noopener';actions.append(a);}
 if(w.workflow?.state==='rework')detail.append(make('div','На доработку: '+w.workflow.review_comment,'reason'));
 const gallery=make('div',null,'gallery');detail.append(gallery);
 for(const item of photos){const box=make('figure');const img=make('img',null,'site-image');img.alt='Обзор площадки';box.append(img,make('figcaption',item.photo_filename));if(writable)box.append(btn('Убрать фото',()=>{if(confirm('Убрать этот кадр из текущей оцифровки?'))mutate(()=>api(flow+'/sites/'+id+'/photos/'+item.id,{method:'DELETE'}),'Фотография убрана');},'btn mini danger'));gallery.append(box);photo(flow+'/sites/'+id+'/photos/'+item.id,img,seq);}
 detail.append(state,actions);section(detail,'Обзорные фото · '+photos.length);
 if(!photos.length)detail.append(make('p','Новые обзорные фото ещё не загружены.','sub'));
 if(writable){const form=make('form',null,'buttons'),input=uploadInput(true),upload=make('button','Загрузить фото площадки','btn primary');input.required=true;input.setAttribute('aria-label','Новые обзорные фотографии площадки');form.append(input,upload);upload.type='submit';form.onsubmit=e=>{e.preventDefault();const files=[...input.files];mutate(async()=>{for(const f of files)await sendPhoto(flow+'/sites/'+id+'/photos',f);},'Обзорные фото сохранены');};detail.append(form);}
 section(detail,'Обнаруженные МАФ ('+items.length+')');
 for(const item of items){
  const row=make('div',null,'maf-item'),body=make('div',null,'maf-body');
  if(item.photo_id){const img=make('img',null,'maf-photo');img.alt='Фото МАФ';row.append(img);photo(flow+'/maf/'+item.id+'/photo',img,seq);}
  else row.append(make('div','Нет фото','maf-photo placeholder'));
  body.append(make('b',item.type_label+' × '+item.quantity),make('div',conditions[item.condition]||item.condition,'meta'));if(item.comment)body.append(make('p',item.comment,'comment'));
  if(writable){
   const controls=make('div',null,'maf-actions'),input=uploadInput(),edit=make('div');input.hidden=true;
   input.onchange=()=>{const f=input.files[0];if(f)mutate(()=>sendPhoto(base+'/maf/'+item.id+'/photo',f),'Фото МАФ сохранено');};
   controls.append(btn(item.photo_id?'Заменить фото':'Добавить фото',()=>input.click(),'btn mini'),input,
    btn('Изменить',()=>{if(edit.childNodes.length)edit.replaceChildren();else edit.append(mafForm(item,id));},'btn mini'),
    btn('Убрать МАФ',()=>{if(confirm('Убрать МАФ из текущей оцифровки?'))mutate(()=>api(base+'/maf/'+item.id,{method:'DELETE'}),'МАФ убран');},'btn mini danger'));
   body.append(controls,edit);
  }
  row.append(body);detail.append(row);
 }
 if(!items.length)detail.append(make('p','МАФ не добавлены.','sub'));
 if(writable){const add=make('details',null,'add-maf'),summary=make('summary','Добавить МАФ');add.append(summary,mafForm(null,id));detail.append(add);section(detail,'Завершение оцифровки');
  const noMaf=make('input');noMaf.type='checkbox';
  if(!items.length){const label=make('label');label.append(noMaf,document.createTextNode(' На площадке нет МАФ'));detail.append(label);}
  const finish=btn('Отправить на приёмку',()=>mutate(()=>post(flow+'/sites/'+id+'/submit',{noMaf:noMaf.checked}),'Объект передан на приёмку'),'btn primary');
  const block=make('div',null,'buttons submit-actions');block.append(finish);detail.append(block,make('p','Для завершения нужен новый общий снимок и фото каждого внесённого МАФ.','sub'));
 }else if(review&&w.workflow?.state==='submitted'){
  section(detail,'Решение по объекту');const comment=make('textarea',null,'review-text');comment.placeholder='Причина возврата (обязательно для доработки)';comment.maxLength=2000;comment.setAttribute('aria-label','Причина возврата на доработку');
  const block=make('div',null,'buttons');block.append(btn('Принять объект',()=>mutate(()=>post(flow+'/sites/'+id+'/decision',{decision:'accepted',comment:comment.value}),'Объект принят'),'btn primary'),
  btn('Вернуть на доработку',()=>{if(!comment.value.trim()){message('Укажите причину возврата.');comment.focus();return;}mutate(()=>post(flow+'/sites/'+id+'/decision',{decision:'rework',comment:comment.value}),'Объект возвращён в рабочий список');},'btn danger'));detail.append(comment,block);
 }else if(review&&w.workflow?.state==='accepted'){detail.append(make('p','Объект принят.','checked-note'));}
 syncDisabled();
}
$('loginForm').onsubmit=async e=>{e.preventDefault();try{const res=await fetch(API+'/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:$('email').value,email:$('email').value,password:$('password').value})});const d=await res.json();if(!res.ok||!d.token)throw Error(d.error||d.message||'Не удалось войти');token=d.token;localStorage.setItem('saoPhotoToken',token);appView(d.user||{});await dictionaries();await resetQueue();}catch(e){loginView(e.message);}};
$('logout').onclick=async()=>{try{await req('/auth/logout',{method:'POST'});}catch{}token='';localStorage.removeItem('saoPhotoToken');localStorage.removeItem('sao-photo-token');clearDetail();loginView();};
$('refresh').onclick=resetQueue;$('district').onchange=resetQueue;$('kind').onchange=resetQueue;
if(review){$('reviewQueue').classList.toggle('primary',queue==='review');$('acceptedQueue').classList.toggle('primary',queue==='accepted');const setQueue=q=>{if(busy)return;queue=q;$('reviewQueue').classList.toggle('primary',q==='review');$('acceptedQueue').classList.toggle('primary',q==='accepted');resetQueue();};$('reviewQueue').onclick=()=>setQueue('review');$('acceptedQueue').onclick=()=>setQueue('accepted');}
$('closeViewer').onclick=()=>$('viewer').close();$('viewer').onclose=()=>{$('largePhoto').removeAttribute('src');if(photoTrigger?.isConnected)photoTrigger.focus();};
(async()=>{try{if(!token){loginView();return;}const d=await api('/auth/me');appView(d.user||{});await dictionaries();await resetQueue();}catch(e){loginView(e.message);}})();
})();
