const {test,expect}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(process.env.SLOT_SOURCE || path.join(__dirname,'../../object-maps/photo-slots.js'),'utf8');
async function setup(page){
  await page.setContent('<div id="slotPanel"></div>');
  await page.evaluate(()=>{
    window.uploads=[];window.notices=[];
    window.TpuPhotoApi={user:()=>({role:'prefecture_admin'}),request:async(url,options)=>{
      if(options?.method==='PUT'){
        window.uploads.push({url,size:options.body.size,type:options.body.type,name:options.headers['X-Photo-Filename']});
        if(options.body.size>900*1024)throw new Error('request entity too large');
        return {json:async()=>({photo:{}})};
      }
      return {json:async()=>url.endsWith('/public')?{objects:[]}:{required:1,accepted:0,status:'empty',slots:[{slot:1}]}};
    }};
  });
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{window.slots=SaoPhotoSlots.mount({notify:(message,error)=>notices.push({message,error})});slots.open({id:'parking:1140159703',group:'Коптево'});});
  await expect(page.locator('input[type=file]')).toHaveCount(1);
}
test('phone PNG larger than 5 MB is sent as bounded JPEG',async({page})=>{
  await setup(page);
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=1800;
    const ctx=canvas.getContext('2d');const pixels=ctx.createImageData(canvas.width,canvas.height);
    let seed=12345;for(let i=0;i<pixels.data.length;i+=4){for(let j=0;j<3;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i+j]=seed>>>24;}pixels.data[i+3]=255;}
    ctx.putImageData(pixels,0,0);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
    if(blob.size<=5*1024*1024)throw new Error('fixture too small');
    const transfer=new DataTransfer();transfer.items.add(new File([blob],'camera.png',{type:'image/png'}));
    const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change'));
  });
  await expect.poll(()=>page.evaluate(()=>notices.length)).toBeGreaterThan(0);
  const result=await page.evaluate(()=>({uploads,notices}));
  expect(result.notices.at(-1).error).toBeFalsy();expect(result.uploads).toHaveLength(1);
  expect(result.uploads[0].size).toBeLessThanOrEqual(900*1024);expect(result.uploads[0].type).toBe('image/jpeg');expect(result.uploads[0].name).toBe('camera.jpg');
});
test('small JPEG stays unchanged',async({page})=>{
  await setup(page);
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;
    const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg'));window.originalSize=blob.size;
    const transfer=new DataTransfer();transfer.items.add(new File([blob],'small.jpg',{type:'image/jpeg'}));
    const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change'));
  });
  await expect.poll(()=>page.evaluate(()=>uploads.length)).toBe(1);
  expect(await page.evaluate(()=>uploads[0].size===originalSize)).toBe(true);
});
test('unsupported file is rejected before upload with usable message',async({page})=>{
  await setup(page);
  await page.locator('input[type=file]').setInputFiles({name:'camera.heic',mimeType:'image/heic',buffer:Buffer.from('heic')});
  await expect.poll(()=>page.evaluate(()=>notices.length)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>uploads.length)).toBe(0);
  expect(await page.evaluate(()=>notices.at(-1).message)).toMatch(/JPEG|PNG|WebP/);
});
test('server size rejection has a Russian retry message and allows same file again',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{const request=TpuPhotoApi.request;TpuPhotoApi.request=(url,options)=>options?.method==='PUT'?Promise.reject(new Error('request entity too large')):request(url,options);});
  await page.locator('input[type=file]').setInputFiles({name:'small.jpg',mimeType:'image/jpeg',buffer:Buffer.from([255,216,255,217])});
  await expect.poll(()=>page.evaluate(()=>notices.length)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>notices.at(-1).message)).toContain('Сервер отклонил размер фото');
  await expect(page.locator('input[type=file]')).toBeEnabled();
  expect(await page.locator('input[type=file]').inputValue()).toBe('');
});
