import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('https://hainox.github.io/karta-sao/districts/aeroport.html');
await page.waitForSelector('#shootToggle', { timeout: 30000 });
await page.waitForTimeout(3500);

await page.evaluate(`(async () => {
  const ymaps3 = window.ymaps3;
  await ymaps3.ready;
  const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapListener } = ymaps3;
  window.__probeArgs = { clicks: [] };
  const el = document.createElement('div');
  el.id = 'probe-args';
  el.style.cssText = 'position:fixed;width:200px;height:140px;left:20px;top:10px;z-index:99999';
  document.body.appendChild(el);
  const map = new YMap(el, { location: { center: [37.5, 55.8], zoom: 13 } }, [new YMapDefaultSchemeLayer({}), new YMapDefaultFeaturesLayer({})]);
  map.addChild(new YMapListener({ layer: 'any', onClick: (a, b) => window.__probeArgs.clicks.push({
    first: a == null ? 'null' : Object.keys(a).slice(0, 3),
    second: b ? { coords: b.coordinates, keys: Object.keys(b).slice(0, 6) } : null,
  }) }));
})()`);
await page.waitForTimeout(2500);

const box = await page.locator('#probe-args').boundingBox();
await page.mouse.click(box.x + 100, box.y + 60);
await page.waitForTimeout(400);
console.log(await page.evaluate(() => JSON.stringify(window.__probeArgs.clicks)));
await browser.close();
