// Ловит точные адреса битых запросов на конкретной странице атласа.
import { chromium } from 'playwright';

const BASE = process.env.ATLAS_BASE || 'https://hainox.github.io/karta-sao';
const targets = process.argv.slice(2);
if (!targets.length) targets.push('/smm/');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

for (const target of targets) {
  const page = await context.newPage();
  const failures = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    failures.push(`ОБРЫВ ${request.failure()?.errorText} ${request.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`КОНСОЛЬ ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`JS ${String(error).split('\n')[0]}`));

  await page.goto(`${BASE}${target}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(12_000);

  const brokenImages = await page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .filter((img) => img.complete && img.naturalWidth === 0 && img.src && !img.src.startsWith('data:'))
      .map((img) => img.src));

  console.log(`\n=== ${target} ===`);
  if (!failures.length && !brokenImages.length) console.log('  чисто');
  for (const failure of [...new Set(failures)]) console.log('  ' + failure.slice(0, 220));
  for (const image of [...new Set(brokenImages)]) console.log('  битая картинка ' + image.slice(0, 220));
  await page.close();
}

await browser.close();
