// Проверка собранной карты с диска, без внешней подложки и сетевых запросов.
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { chromium } = createRequire(join(__dirname, '../../../../odh-map/package.json'))('playwright');

async function run() {
  const output = join(__dirname, 'review-map');
  mkdirSync(join(output, 'examples'), { recursive: true });
  const browser = await chromium.launch({channel: process.env.CI ? undefined : 'msedge'});
  try {
    const page = await browser.newPage({viewport:{width:1152,height:700}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:/, route => { errors.push(route.request().url()); return route.abort(); });
    await page.goto(pathToFileURL(join(output, 'index.html')).href);
    const saved = new Set();
    const totals = [];
    for (const file of await page.locator('#district option').evaluateAll(opts => opts.map(o=>o.value))) {
      await page.selectOption('#district', file);
      await page.waitForFunction(file=>data && data.before[0].xy[0]===view.lon && activeScript.src.endsWith(file) &&
        data.before[0].id && revision.endsWith(file),file);
      const examples = await page.evaluate(()=>document.querySelector('#example').options.length-1);
      totals.push(await page.evaluate(()=>data.working.length));
      for (let i=0;i<examples;i++) {
        await page.selectOption('#example',String(i));
        const info = await page.evaluate(()=> {
          const f=examples[el('example').value].feature;
          return {rule:f.rule, route:f.route, x:view.x, zoom:view.zoom};
        });
        assert.ok(Number.isFinite(info.x) && info.zoom>0);
        if (!saved.has(info.rule)) {
          await page.screenshot({path: join(output,'examples',info.rule+'.png')});
          saved.add(info.rule);
        }
      }
    }
    assert.equal(totals.length,16);
    assert.equal(saved.size,7);
    await page.setViewportSize({width:390,height:740});
    await page.selectOption('#district',{index:0});
    await page.waitForFunction(()=>revision.endsWith(el('district').value));
    await page.screenshot({path:join(output,'examples','phone.png')});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const initial = await page.evaluate(()=>data.working.length);
    await page.getByRole('button',{name:'Добавить в копию'}).click();
    await page.locator('canvas').click({position:{x:70,y:90}});
    await page.locator('#bearing').fill('71.5');
    await page.getByRole('button',{name:'Сохранить угол'}).click();
    const id = await page.evaluate(()=>selected.id);
    await page.reload();
    await page.waitForFunction(()=>data?.working);
    const changed = await page.evaluate(id=>data.working.find(p=>p.id===id),id);
    assert.deepEqual(changed.frames,[[id+'-1',71.5]]);
    const pos = await page.evaluate(id=>{
      const p=data.working.find(p=>p.id===id);el('before').checked=false;
      fit([p.xy[0]-.0002,p.xy[1]-.0002,p.xy[0]+.0002,p.xy[1]+.0002]);
      const [x,y]=screen(p.xy);return {x,y};
    },id);
    await page.locator('canvas').click({position:pos});
    await page.getByRole('button',{name:'Убрать из копии'}).click();
    assert.equal(await page.evaluate(()=>data.working.length),initial);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({districts:totals.length,points:totals.reduce((a,b)=>a+b,0),examples:[...saved],localEditSurvivedReload:true}));
  } finally { await browser.close(); }
}
run().catch(e=>{console.error(e);process.exitCode=1});
