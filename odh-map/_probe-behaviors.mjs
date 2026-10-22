import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('https://hainox.github.io/karta-sao/districts/aeroport.html');
await page.waitForSelector('#shootToggle', { timeout: 30000 });
await page.waitForTimeout(3500);

// две пробные карты: с behaviors и без prop'а
await page.evaluate(`(async () => {
  const ymaps3 = window.ymaps3;
  await ymaps3.ready;
  const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapListener } = ymaps3;
  window.__probeClicks = { withList: [], withoutProp: [] };
  const mk = (name, behaviors) => {
    const el = document.createElement('div');
    el.id = 'probe-' + name;
    el.className = 'probe-map';
    el.style.cssText = 'position:fixed;width:220px;height:150px;left:20px;z-index:99999';
    el.style.top = name === 'withList' ? '10px' : '200px';
    document.body.appendChild(el);
    const map = new YMap(el, { location: { center: [37.5, 55.8], zoom: 13 }, behaviors }, [new YMapDefaultSchemeLayer({}), new YMapDefaultFeaturesLayer({})]);
    map.addChild(new YMapListener({ layer: 'any', onClick: (obj) => window.__probeClicks[name].push(obj && obj.coordinates) }));
    return el;
  };
  mk('withList', ['drag', 'scrollZoom', 'pinchZoom', 'oneFingerZoom', 'doubleTapZoom']);
  mk('withoutProp', undefined);
})()`);
await page.waitForTimeout(2500);

const withBox = await page.locator('#probe-withList').boundingBox();
const withoutBox = await page.locator('#probe-withoutProp').boundingBox();
await page.mouse.click(withBox.x + 110, withBox.y + 70);
await page.waitForTimeout(300);
await page.mouse.click(withoutBox.x + 110, withoutBox.y + 70);
await page.waitForTimeout(300);
console.log('с behaviors     :', (await page.evaluate(() => window.__probeClicks.withList)));
console.log('без behaviors   :', (await page.evaluate(() => window.__probeClicks.withoutProp)));
await browser.close();
