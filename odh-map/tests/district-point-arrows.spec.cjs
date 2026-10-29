const {test,expect}=require('@playwright/test');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const template=readFileSync(path.join(root,'work/district_page_template.html'),'utf8');
const start=template.lastIndexOf('<script>')+8;
let script=template.slice(start,template.lastIndexOf('</script>'));
script=script.slice(0,script.lastIndexOf('  createMap().catch'))+`window.districtArrowTest={state,pointMarkerElement,handleMapClick,previewHeading,renderShootMarkers,setShootMode,openPointCard};})();`;
const editor=readFileSync(path.join(root,'districts/point-editor.js'),'utf8');
const sdk=`window.markers=[];class Marker {constructor(options,element){this.options=options;this.element=element;this.element.dataset.coordinates=JSON.stringify(options.coordinates);markers.push(this);} update(options){Object.assign(this.options,options);if(options.coordinates)this.element.dataset.coordinates=JSON.stringify(options.coordinates);} } window.ymaps3={YMapMarker:Marker};`;
async function setup(page,seed=[]){
  const writes=[];
  let created=null;
  await page.route('https://obhod-sao.ru/photo-api/**',async route=>{
    const req=route.request(),body=req.postDataJSON();
    if(req.method()!=='GET')writes.push({method:req.method(),body});
    if(req.method()==='POST'){created={id:'new-point',label:'1.1',longitude:body.longitude,latitude:body.latitude,heading:body.heading,district:'Аэропорт'};return route.fulfill({json:{point:created}});}
    // После сохранения карта перечитывает список точек; у GET тела нет.
    if(req.method()==='GET')return route.fulfill({json:{points:created?[created]:seed}});
    return route.fulfill({json:{point:{...seed[0],heading:body.heading}}});
  });
  const clean=template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');
  await page.route('http://district.test/**',route=>route.fulfill({contentType:'text/html',body:clean}));
  await page.goto('http://district.test/districts/arrow-fixture.html');
  await page.addScriptTag({content:sdk});await page.addScriptTag({content:editor});await page.addScriptTag({content:script});
  await page.evaluate(seed=>{
    const t=window.districtArrowTest;
    t.state.map={zoom:17,addChild(marker){document.getElementById('map').append(marker.element);},removeChild(marker){marker.element.remove();},update(){}};
    t.state.editor=window.createPointEditor({map:t.state.map,popover:null});
    t.state.photoUser={role:'prefecture_admin'};t.state.serverOk=true;t.state.shootLayerOn=true;t.state.points=seed;
    t.renderShootMarkers();
  },seed);
  return writes;
}
test('сохранённые направления 0°, 90° и 270° видны, неизвестное не рисуется как север',async({page})=>{
  await setup(page,[0,90,270,null].map((heading,i)=>({id:'p'+i,label:'1.'+i,heading,lng:37.5,lat:55.8,photo_state:'accepted'})));
  await expect(page.locator('.shoot-marker svg')).toHaveCount(3);
  // Стрелки видны и в обычном просмотре: так решили в #35, режим разметки их не прячет.
  await expect(page.locator('.shoot-marker svg').first()).toBeVisible();
  await page.evaluate(()=>window.districtArrowTest.setShootMode(true));
  await expect(page.locator('.shoot-marker svg').first()).toBeVisible();
  await expect(page.locator('#shootToggle')).toHaveText('✓ Готово');
  for(const [i,heading]of [0,90,270].entries())await expect(page.locator('.shoot-marker').nth(i).locator('svg')).toHaveAttribute('style',new RegExp('rotate\\('+heading+'deg\\)'));
});
test('два клика создают точку со стрелкой; координаты остаются у первого клика',async({page})=>{
  const writes=await setup(page);
  await page.evaluate(()=>{const t=window.districtArrowTest;t.setShootMode(true);t.handleMapClick([37.5,55.8]);t.handleMapClick([37.501,55.8]);});
  await expect(page.locator('#shootHint')).toContainText('подтверждена сервером');
  expect(writes).toHaveLength(1);expect(writes[0].body.heading).toBe(90);
  await expect(page.locator('.shoot-marker:not(.preview) svg')).toHaveCount(1);
  await expect(page.locator('.shoot-marker:not(.preview)')).toHaveAttribute('data-coordinates','[37.5,55.8]');
});
test('черновик: стрелка смотрит за мышью до второго клика',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{const t=window.districtArrowTest;t.setShootMode(true);t.handleMapClick([37.5,55.8]);t.previewHeading([37.5,55.79]);});
  await expect(page.locator('.shoot-marker.preview svg')).toHaveAttribute('style',/rotate\(180deg\)/);
});
test('ручка поворота сохраняет направление сама; приёмка и координаты не меняются',async({page})=>{
  const point={id:'accepted',label:'1.1',heading:90,lng:37.5,lat:55.8,serverPoint:true,photo_state:'accepted'};
  const writes=await setup(page,[point]);
  await page.evaluate(()=>document.querySelector('.shoot-marker').click());
  await expect(page.locator('.rot-knob')).toHaveCount(1);
  await expect(page.locator('.shoot-marker')).toHaveClass(/selected/);
  await page.evaluate(()=>{const knob=window.markers.find(m=>m.element.classList.contains('rot-knob'));knob.options.onDragStart();knob.options.onDragMove([37.5,55.801]);knob.options.onDragEnd([37.5,55.801]);});
  await expect(page.locator('.edit-toast')).toContainText('Направление 0° сохранено');
  expect(writes).toEqual([{method:'PATCH',body:{heading:0}}]);
  await expect(page.locator('.shoot-marker')).toHaveAttribute('data-photo-state','accepted');
  await expect(page.locator('.shoot-marker svg')).toHaveAttribute('style',/rotate\(0deg\)/);
  await expect(page.locator('.shoot-marker')).toHaveAttribute('data-coordinates','[37.5,55.8]');
  await expect(page.locator('.rot-knob')).toHaveCount(1);
});
test('выбранную точку тащат мышью; «Отменить» возвращает её на место',async({page})=>{
  const point={id:'p1',label:'1.1',heading:90,lng:37.5,lat:55.8,serverPoint:true,photo_state:'empty'};
  const writes=[];
  await setup(page,[point]);
  await page.unroute('https://obhod-sao.ru/photo-api/**');
  await page.route('https://obhod-sao.ru/photo-api/**',route=>{const req=route.request();const body=req.postDataJSON();
    if(req.method()==='PATCH'){writes.push(body);return route.fulfill({json:{point:{...point,longitude:body.longitude,latitude:body.latitude}}});}
    return route.fulfill({json:{photos:[],points:[point]}});});
  await page.evaluate(()=>document.querySelector('.shoot-marker').click());
  const draggable=await page.evaluate(()=>window.markers.filter(m=>m.element.classList.contains('shoot-marker')).pop().options.draggable);
  expect(draggable).toBe(true);
  await page.evaluate(()=>{const m=window.markers.filter(m=>m.element.classList.contains('shoot-marker')).pop();m.options.onDragStart();m.options.onDragMove([37.502,55.801]);m.options.onDragEnd([37.502,55.801]);});
  await expect(page.locator('.edit-toast')).toContainText('Точка перенесена');
  await page.getByRole('button',{name:'Отменить'}).click();
  await expect(page.locator('.edit-toast')).toContainText('Вернули как было');
  expect(writes).toEqual([{longitude:37.502,latitude:55.801},{longitude:37.5,latitude:55.8}]);
});
