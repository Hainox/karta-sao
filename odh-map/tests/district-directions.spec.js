import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = `class YMap { constructor(element) { this.element=element; this.zoom=13; } addChild(child) { if(child.element) this.element.append(child.element); return this; } removeChild(child) { child.element?.remove(); return this; } update() {} }
const markers=[];
class YMapMarker { constructor(options, element) { this.options=options; this.element=element; element.dataset.coordinates=JSON.stringify(options.coordinates); markers.push(this); } update(options) { Object.assign(this.options,options); if(options.coordinates) this.element.dataset.coordinates=JSON.stringify(options.coordinates); } }
window.directionTestDrag=async(fid,coordinates)=>{ const marker=markers.find(marker=>Number(marker.element.dataset.fid)===fid); if(!marker.options.draggable) throw Error('not draggable'); marker.options.onDragMove?.(coordinates); await marker.options.onDragEnd(coordinates); };
class YMapFeature { constructor(options) { this.options=options; } }
class Layer {}
const listeners=[];
class YMapListener { constructor(options) { listeners.push(options); } }
window.directionTestZoom=zoom=>listeners.forEach(listener=>listener.onUpdate?.({location:{zoom}}));
window.directionTestClick=coordinates=>listeners.forEach(listener=>listener.onClick?.(undefined,{coordinates}));
window.ymaps3={ready:Promise.resolve(),YMap,YMapMarker,YMapFeature,YMapDefaultSchemeLayer:Layer,YMapDefaultFeaturesLayer:Layer,YMapListener};`;

for (const [slug, count] of [['vostochnoe-degunino',68],['beskudnikovskiy',19],['aeroport',0]]) {
  test('отдельный слой направлений: ' + slug, async ({page}) => {
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://api-maps.yandex.ru/v3/**', route=>route.fulfill({contentType:'text/javascript',body:sdk}));
    await page.route('https://obhod-sao.ru/photo-api/**', route=>route.fulfill({json:route.request().url().includes('/directions/public')?{corrections:[]}:{points:[]}}));
    await page.goto('http://127.0.0.1:8766/districts/'+slug+'.html');
    await expect(page.locator('#layerControls .layer-row').first()).toBeVisible();
    if (!count) {
      await expect(page.locator('#status')).toContainText('Загружено объектов');
      await expect(page.locator('#directionLayerToggle')).toHaveCount(0);
      await expect(page.locator('.direction-marker')).toHaveCount(0);
    } else {
      await expect(page.locator('.direction-marker')).toHaveCount(count);
      await expect(page.locator('#directionLayerToggle')).toBeChecked();
      const marker=page.locator('.direction-marker').first();
      const azimuth=await marker.getAttribute('data-azimuth');
      const rotation = await marker.locator('svg').evaluate(svg => parseFloat(svg.style.transform.replace('rotate(', '')));
      expect(Math.abs(rotation - Number(azimuth))).toBeLessThan(0.001);
      const scale = () => marker.locator('svg').evaluate(svg => Number(svg.style.transform.match(/scale\(([^)]+)\)/)[1]));
      const overviewScale = await scale();
      expect(overviewScale).toBeLessThanOrEqual(0.3);
      const anchor = await marker.getAttribute('data-coordinates');
      const dot = marker.locator('.direction-anchor');
      const center = await dot.evaluate(el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];});
      await page.evaluate(() => window.directionTestZoom(18));
      expect(await scale()).toBe(1);
      await page.evaluate(() => window.directionTestZoom(14));
      expect(await scale()).toBe(0.25);
      await page.evaluate(() => window.directionTestZoom(8));
      expect(await scale()).toBe(0.18);
      await expect(marker).toHaveAttribute('data-coordinates', anchor);
      const centerAfter = await dot.evaluate(el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];});
      expect(centerAfter).toEqual(center);
      await marker.dispatchEvent('click');
      await expect(page.locator('#card')).toContainText('Азимут: '+azimuth+'°');
      await page.locator('#directionLayerToggle').uncheck();
      await expect(page.locator('.direction-marker')).toHaveCount(0);
      await expect(page.locator('#shootLayerToggle')).not.toBeChecked();
      await page.locator('#directionLayerToggle').check();
      await expect(page.locator('.direction-marker')).toHaveCount(count);
    }
    expect(errors).toEqual([]);
  });
}

test('редактор направлений: перемещение, азимут, сохранение и конфликт', async ({page}) => {
  const corrections=new Map(); let fail=false;
  await page.route('**/districts/direction-fixture.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.route('**/direction-fixture-api/**', async route => {
    const request=route.request();
    if(request.method()==='PATCH') {
      if(fail) return route.fulfill({status:503,json:{error:'Сервер временно недоступен'}});
      const fid=Number(request.url().split('/').at(-1));
      const body=request.postDataJSON(), old=corrections.get(fid);
      if(body.expectedVersion!==(old?.version??0)) return route.fulfill({status:409,json:{error:'Направление уже изменено'}});
      const correction={fid,longitude:body.longitude,latitude:body.latitude,azimuth:body.azimuth,version:(old?.version??0)+1};
      corrections.set(fid,correction);
      return route.fulfill({json:{correction}});
    }
    return route.fulfill({json:{corrections:[...corrections.values()]}});
  });
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  async function open() {
    await page.goto('http://127.0.0.1:8766/districts/direction-fixture.html');
    await page.setContent('<div id="map"></div><div id="controls"></div><div id="card"></div>');
    await page.addScriptTag({content:sdk});
    await page.addStyleTag({path:path.join(root,'districts/direction-arrows.css')});
    await page.addScriptTag({path:path.join(root,'districts/direction-arrows.js')});
    await page.evaluate(async()=>{
      window.directionFixtureUser={role:'prefecture_admin'};
      window.directionFixture=await SaoDistrictDirections.mount({map:new ymaps3.YMap(document.getElementById('map')),slug:'vostochnoe-degunino',controls:document.getElementById('controls'),card:document.getElementById('card'),getUser:()=>window.directionFixtureUser,request:async(url,options)=>{
        const response=await fetch('/direction-fixture-api'+url.split('/directions')[1],options);
        if(!response.ok)throw Error((await response.json()).error);
        return response;
      }});
    });
  }
  await open();
  const toggle=page.locator('#directionEditToggle');
  await expect(toggle).toBeEnabled(); await toggle.click();
  const marker=page.locator('.direction-marker[data-fid="8"]');
  const original=JSON.parse(await marker.getAttribute('data-coordinates'));
  const moved=[original[0]+0.00001,original[1]+0.00001];
  await page.evaluate(moved=>window.directionTestDrag(8,moved),moved);
  await expect(page.locator('#directionEditStatus')).toContainText('сохранено');
  expect(corrections.get(8).longitude).toBe(moved[0]);
  await open();
  await expect(marker).toHaveAttribute('data-coordinates',JSON.stringify(moved));
  await toggle.click(); await marker.dispatchEvent('click');
  await page.locator('.direction-card-actions input').fill('90');
  await page.getByRole('button',{name:'Сохранить азимут',exact:true}).click();
  await expect(marker).toHaveAttribute('data-azimuth','90');
  await page.getByRole('button',{name:'Указать направление на карте',exact:true}).click();
  await page.evaluate(moved=>window.directionTestClick([moved[0]+0.001,moved[1]]),moved);
  await expect(page.locator('#directionEditStatus')).toContainText('сохранено');
  expect(corrections.get(8).azimuth).toBeGreaterThan(89);
  expect(corrections.get(8).azimuth).toBeLessThan(91);
  corrections.set(8,{...corrections.get(8),azimuth:180,version:corrections.get(8).version+1});
  await page.evaluate(moved=>window.directionTestDrag(8,[moved[0]+0.00001,moved[1]]),moved);
  await expect(page.locator('#directionEditStatus')).toContainText('уже изменено');
  await expect(marker).toHaveAttribute('data-azimuth','180');
  await expect(marker).toHaveAttribute('data-coordinates',JSON.stringify(moved));
  fail=true;
  await page.evaluate(moved=>window.directionTestDrag(8,[moved[0]+0.00001,moved[1]]),moved);
  await expect(page.locator('#directionEditStatus')).toContainText('не сохранена');
  await expect(marker).toHaveAttribute('data-coordinates',JSON.stringify(moved));
  await page.evaluate(()=>{window.directionFixtureUser=null;window.directionFixture.refreshUser();});
  await expect(toggle).toBeHidden();
  await expect(marker).not.toHaveClass(/editing/);
});
