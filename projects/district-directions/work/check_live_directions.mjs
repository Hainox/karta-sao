import assert from 'node:assert/strict';
import { chromium } from '../../../odh-map/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = []; page.on('pageerror', error=>errors.push(error.message));
  for (const [slug,count] of [['vostochnoe-degunino',68],['beskudnikovskiy',19]]) {
    await page.goto((process.argv[2] || 'https://hainox.github.io/karta-sao/') + 'districts/' + slug + '.html', {waitUntil:'domcontentloaded'});
    await page.locator('#directionLayerToggle').waitFor({timeout:60000});
    assert.equal(await page.locator('.direction-marker').count(),count);
    await page.locator('#directionLayerToggle').uncheck();
    assert.equal(await page.locator('.direction-marker').count(),0);
    await page.locator('#directionLayerToggle').check();
    assert.equal(await page.locator('.direction-marker').count(),count);
    if (process.argv[3]) await page.screenshot({path:process.argv[3] + '/' + slug + '.png'});
    console.log('PASS live map ' + slug + ': ' + count + ' arrows, independent toggle.');
  }
  assert.deepEqual(errors,[]);
} finally { await browser.close(); }
