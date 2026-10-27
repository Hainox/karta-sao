const {test,expect}=require('@playwright/test');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const template=readFileSync(path.join(root,'work/district_page_template.html'),'utf8');
const start=template.lastIndexOf('<script>')+8;
let script=template.slice(start,template.lastIndexOf('</script>'));
script=script.slice(0,script.lastIndexOf('  createMap().catch'))+`window.districtArrowTest={state,pointMarkerElement,handleMapClick,beginRotation,renderShootMarkers,setShootMode};})();`;
const sdk=`class Marker {constructor(options,element){this.options=options;this.element=element;this.element.dataset.coordinates=JSON.stringify(options.coordinates);} update(options){Object.assign(this.options,options);} } window.ymaps3={YMapMarker:Marker};`;
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
  await page.addScriptTag({content:sdk});await page.addScriptTag({content:script});
  await page.evaluate(seed=>{
    const t=window.districtArrowTest;
    t.state.map={addChild(marker){document.getElementById('map').append(marker.element);},removeChild(marker){marker.element.remove();},update(){}};
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
test('смена направления принятой точки сохраняет приёмку и координаты',async({page})=>{
  const point={id:'accepted',label:'1.1',heading:90,lng:37.5,lat:55.8,serverPoint:true,photo_state:'accepted'};
  const writes=await setup(page,[point]);
  await page.evaluate(()=>{const t=window.districtArrowTest;t.beginRotation(t.state.points[0]);t.handleMapClick([37.5,55.801]);});
  await expect(page.locator('#shootHint')).toContainText('сохранено');
  expect(writes).toEqual([{method:'PATCH',body:{heading:0}}]);
  await expect(page.locator('.shoot-marker')).toHaveAttribute('data-photo-state','accepted');
  await expect(page.locator('.shoot-marker svg')).toHaveAttribute('style',/rotate\(0deg\)/);
  await expect(page.locator('.shoot-marker')).toHaveAttribute('data-coordinates','[37.5,55.8]');
});
