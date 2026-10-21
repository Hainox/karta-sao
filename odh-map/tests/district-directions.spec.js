import { test, expect } from '@playwright/test';

const sdk = `class YMap { constructor(element) { this.element=element; this.zoom=13; } addChild(child) { if(child.element) this.element.append(child.element); return this; } removeChild(child) { child.element?.remove(); return this; } update() {} }
class YMapMarker { constructor(options, element) { this.element=element; element.dataset.coordinates=JSON.stringify(options.coordinates); } }
class YMapFeature { constructor(options) { this.options=options; } }
class Layer {}
const listeners=[];
class YMapListener { constructor(options) { listeners.push(options); } }
window.directionTestZoom=zoom=>listeners.forEach(listener=>listener.onUpdate?.({location:{zoom}}));
window.ymaps3={ready:Promise.resolve(),YMap,YMapMarker,YMapFeature,YMapDefaultSchemeLayer:Layer,YMapDefaultFeaturesLayer:Layer,YMapListener};`;

for (const [slug, count] of [['vostochnoe-degunino',68],['beskudnikovskiy',19],['aeroport',0]]) {
  test('отдельный слой направлений: ' + slug, async ({page}) => {
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://api-maps.yandex.ru/v3/**', route=>route.fulfill({contentType:'text/javascript',body:sdk}));
    await page.route('https://obhod-sao.ru/photo-api/**', route=>route.fulfill({json:{points:[]}}));
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
      await page.evaluate(() => window.directionTestZoom(18));
      expect(await scale()).toBe(1);
      await page.evaluate(() => window.directionTestZoom(14));
      expect(await scale()).toBe(0.25);
      await page.evaluate(() => window.directionTestZoom(8));
      expect(await scale()).toBe(0.18);
      await expect(marker).toHaveAttribute('data-coordinates', anchor);
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
