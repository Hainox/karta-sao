import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '../../../odh-map/node_modules/@playwright/test/index.mjs';

console.log('Password on hidden stdin:');
process.stdin.setRawMode(true); process.stdin.resume();
let password=await new Promise(resolve=>{
  let value='';
  const onData=chunk=>{
    const text=chunk.toString();
    if(text.includes('\r')||text.includes('\n')) {
      process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();resolve(value+text.split(/[\r\n]/)[0]);
    } else value+=text;
  };
  process.stdin.on('data',onData);
});
const api='https://obhod-sao.ru/photo-api';
const login=await fetch(api+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'префектура',password})});
password='';assert.equal(login.status,200,'prefecture login');
const {token,user}=await login.json();
const key=10;
const source=JSON.parse(readFileSync(new URL('../../../photo-service/src/tpu-points/direction-objects.json',import.meta.url),'utf8')).find(row=>row.fid===key);
const request=(path,options={})=>fetch(api+'/object-photo-points/directions'+path,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});
const current=async()=> (await(await request('/public')).json()).corrections.find(row=>row.fid===key);
const original=await current()||{...source,version:0};
let knownVersion=original.version;
const browser=await chromium.launch({channel:'msedge',headless:true});
const received=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(({token,user})=>{
    sessionStorage.setItem('sao-photo-token',token);sessionStorage.setItem('sao-photo-user',JSON.stringify(user));
  },{token,user});
  const page=await context.newPage();page.setDefaultTimeout(45000);
  page.on('response',response=>{
    if(response.url().endsWith('/directions/'+key)&&response.request().method()==='PATCH'&&response.status()===200) received.push(response.json().then(body=>{knownVersion=body.correction.version;}));
  });
  await page.goto((process.argv[2]||'https://hainox.github.io/karta-sao/')+'districts/beskudnikovskiy.html',{waitUntil:'domcontentloaded'});
  const edit=page.locator('#directionEditToggle');
  await edit.waitFor();await page.waitForFunction(()=>!document.getElementById('directionEditToggle').disabled);
  await edit.click();
  const marker=page.locator('.direction-marker[data-fid="'+key+'"]');
  const dot=marker.locator('.direction-anchor');
  await dot.hover();let box=await dot.boundingBox();assert.ok(box);
  await page.mouse.move(box.x+box.width/2+25,box.y+box.height/2+20);await page.mouse.wheel(0,-900);
  await page.waitForFunction(()=>Number(document.querySelector('.direction-marker svg').style.transform.match(/scale\(([^)]+)\)/)[1])>=0.5);
  await dot.hover();box=await dot.boundingBox();
  const response=page.waitForResponse(response=>response.url().endsWith('/directions/'+key)&&response.request().method()==='PATCH');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2-18,box.y+box.height/2,{steps:12});await page.mouse.up();
  const saved=await response;assert.equal(saved.status(),200);
  await page.waitForFunction(()=>document.getElementById('directionEditStatus').textContent.includes('сохранено'));
  const moved=await current();assert.notEqual(moved.longitude,original.longitude);
  await marker.dispatchEvent('click');
  await page.locator('.direction-card-actions input').fill('90');
  const angleSaved=page.waitForResponse(response=>response.url().endsWith('/directions/'+key)&&response.request().method()==='PATCH');
  await page.getByRole('button',{name:'Сохранить азимут',exact:true}).click();assert.equal((await angleSaved).status(),200);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('.direction-marker[data-fid="10"]')?.dataset.azimuth==='90');
  const persisted=JSON.parse(await marker.getAttribute('data-coordinates'));
  assert.deepEqual(persisted,[moved.longitude,moved.latitude]);
  const offset=()=>dot.evaluate(el=>{const dot=el.getBoundingClientRect(),origin=el.parentElement.getBoundingClientRect();return [dot.x+dot.width/2-origin.x,dot.y+dot.height/2-origin.y];});
  const before=await offset();assert.ok(before.every(value=>Math.abs(value)<0.2));
  await page.mouse.move(1100,500);await page.mouse.wheel(0,-600);
  await page.waitForFunction(()=>Number(document.querySelector('.direction-marker svg').style.transform.match(/scale\(([^)]+)\)/)[1])>0.4);
  const after=await offset();assert.ok(after.every(value=>Math.abs(value)<0.2));
  assert.deepEqual(JSON.parse(await marker.getAttribute('data-coordinates')),persisted);
  if(process.argv[3])await page.screenshot({path:process.argv[3]});
  console.log('PASS live editor: physical drag, heading 90, reload persistence, fixed anchor during zoom.');
} finally {
  await Promise.all(received);
  const latest=await current();
  if(knownVersion>original.version) {
    assert.equal(latest.version,knownVersion,'concurrent change detected; refusing to overwrite');
    const restored=await request('/'+key,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({longitude:original.longitude,latitude:original.latitude,azimuth:original.azimuth,expectedVersion:knownVersion})});
    assert.equal(restored.status,200,'restore original direction');console.log('Original position and azimuth restored.');
  }
  await browser.close();
  await fetch(api+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+token}});
}
