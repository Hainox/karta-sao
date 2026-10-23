const {test,expect}=require('@playwright/test');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const template=readFileSync(path.join(root,'work/district_page_template.html'),'utf8')
  .replaceAll('{{DISTRICT}}','Дмитровский').replaceAll('{{SLUG}}','dmitrovskiy').replaceAll('{{DISTRICT_NO}}','7');
let script=template.slice(template.lastIndexOf('<script>')+8,template.lastIndexOf('</script>'));
script=script.slice(0,script.lastIndexOf('  createMap().catch'))+
  'window.districtPhotoTest={state,openPointCard,renderShootLogin,renderShootMarkers,loadPhotoPoints};})();';
const point={id:'11111111-1111-4111-8111-111111111111',label:'7.549',heading:264,
  lng:37.53655,lat:55.88279,longitude:37.53655,latitude:55.88279,district:'Дмитровский',
  serverPoint:true,assignment_version:3,review_status:'accepted'};
async function setup(page,{role='district_editor',reviewStatus='accepted',photos=[]}={}){
  const writes=[];let stored=photos;
  await page.route('https://obhod-sao.ru/photo-api/**',async route=>{
    const request=route.request();
    if(request.method()==='PUT'){
      writes.push({url:request.url(),headers:request.headers(),bytes:request.postDataBuffer()});
      stored=[{id:'22222222-2222-4222-8222-222222222222',status:'pending',uploaded_at:'2026-10-23T12:00:00Z'}];
      return route.fulfill({json:{photo:stored[0]}});
    }
    if(request.url().endsWith('/photos'))return route.fulfill({json:{photos:stored}});
    if(request.url().includes('/photos/'))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')});
    return route.fulfill({json:{points:[{...point,review_status:reviewStatus}]}});
  });
  const clean=template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');
  await page.route('http://district.test/**',route=>route.fulfill({contentType:'text/html',body:clean}));
  await page.goto('http://district.test/districts/dmitrovskiy.html');
  await page.addScriptTag({content:'window.ymaps3={YMapMarker:class {constructor(options,element){this.element=element;}}};'});
  await page.addScriptTag({content:script});
  await page.evaluate(({point,role,reviewStatus})=>{
    const t=window.districtPhotoTest;t.state.serverOk=true;
    t.state.photoUser={role,district:'Дмитровский'};
    t.state.points=[{...point,review_status:reviewStatus}];
    t.renderShootLogin();
    return t.openPointCard(t.state.points[0]);
  },{point,role,reviewStatus});
  return writes;
}
test('район видит кнопку слота; выбор файла отправляет фото к выбранной точке',async({page})=>{
  const writes=await setup(page);
  const upload=page.getByRole('button',{name:'Загрузить фото',exact:true});
  await expect(upload).toBeVisible();
  const chooserPromise=page.waitForEvent('filechooser');await upload.click();
  const chooser=await chooserPromise;
  await chooser.setFiles({name:'point.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')});
  await expect(page.locator('#cardSlot .slot-pill')).toHaveText('На проверке');
  expect(writes).toHaveLength(1);
  expect(writes[0].url.endsWith('/'+point.id+'/photos')).toBe(true);
  expect(writes[0].headers['x-assignment-version']).toBe('3');
  expect(writes[0].headers['content-type']).toBe('image/png');
  expect(writes[0].bytes.length).toBeGreaterThan(0);
  await expect(page.getByRole('button',{name:'Загрузить фото',exact:true})).toHaveCount(0);
});
test('район видит пересдачу с комментарием отклонённого фото',async({page})=>{
  await setup(page,{photos:[{id:'rejected',status:'rejected',review_comment:'Переснять по стрелке'}]});
  await expect(page.locator('#cardSlot')).toContainText('Переснять по стрелке');
  await expect(page.getByRole('button',{name:'Загрузить фото',exact:true})).toBeVisible();
});
for (const reviewStatus of ['pending','rework']) test('старый статус точки '+reviewStatus+' не блокирует фотослот',async({page})=>{
  await setup(page,{reviewStatus});
  await expect(page.getByRole('button',{name:'Загрузить фото',exact:true})).toBeVisible();
  await expect(page.locator('#card')).not.toContainText('Статус приёмки точки');
  await expect(page.locator('#cardSlot')).not.toContainText('после приёмки точки');
});
for(const role of ['district_editor','prefecture_admin'])test('единственный точечный слой для '+role,async({page})=>{
  await setup(page,{role});
  await expect(page.locator('#shootLayerRow')).toBeVisible();
  await expect(page.locator('#gpkgLayerRow,#prefectureArchiveRow')).toHaveCount(0);
  expect(template).not.toContain('SaoDistrictDirections.mount');
  expect(template).not.toContain('/prefecture-archive?');
});
test('району не предлагается отправлять фото в чужую точку',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{const t=window.districtPhotoTest;t.state.points[0].district='Аэропорт';return t.openPointCard(t.state.points[0]);});
  await expect(page.getByRole('button',{name:'Загрузить фото',exact:true})).toHaveCount(0);
});
test('ошибка отправки видна в слоте и позволяет выбрать тот же файл повторно',async({page})=>{
  await setup(page);
  await page.route('https://obhod-sao.ru/photo-api/**',async(route)=>{
    if(route.request().method()==='PUT')return route.fulfill({status:503,json:{error:'Сервис временно недоступен'}});
    return route.fallback();
  });
  await page.locator('#cardSlot input[type=file]').setInputFiles({name:'point.png',mimeType:'image/png',buffer:Buffer.from([137,80,78,71])});
  await expect(page.locator('#cardSlot [role=status]')).toContainText('Сервис временно недоступен');
  await expect(page.getByRole('button',{name:'Загрузить фото',exact:true})).toBeEnabled();
  await expect(page.locator('#cardSlot input[type=file]')).toHaveValue('');
});
test('на телефоне видна кнопка загрузки высотой не меньше 44 px',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await setup(page);
  const upload=page.getByRole('button',{name:'Загрузить фото',exact:true});
  await upload.scrollIntoViewIfNeeded();
  await expect(upload).toBeVisible();
  expect((await upload.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await page.locator('#card').screenshot({path:testInfo.outputPath('district-photo-slot-mobile.png')});
});
