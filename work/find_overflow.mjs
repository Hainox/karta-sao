// Ищет элементы, из-за которых на узком экране появляется горизонтальная прокрутка.
import { chromium } from 'playwright';

const BASE = process.env.ATLAS_BASE || 'https://hainox.github.io/karta-sao';
const targets = process.argv.slice(2);
if (!targets.length) targets.push('/odh-map/prefecture-guide.html');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

for (const target of targets) {
  const page = await context.newPage();
  await page.goto(`${BASE}${target}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4000);

  const report = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const offenders = [];
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right > width + 1 || box.left < -1) {
        const style = getComputedStyle(element);
        offenders.push({
          tag: element.tagName.toLowerCase(),
          cls: (element.className || '').toString().slice(0, 60),
          text: (element.textContent || '').trim().slice(0, 40),
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
          position: style.position
        });
      }
    }
    return { width, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 12) };
  });

  console.log(`\n=== ${target} (ширина ${report.width}, прокрутка ${report.scrollWidth}) ===`);
  if (!report.offenders.length) console.log('  виновников нет');
  for (const item of report.offenders) {
    console.log(`  <${item.tag} class="${item.cls}"> ${item.left}..${item.right} (${item.width}px, ${item.position}) «${item.text}»`);
  }
  await page.close();
}

await browser.close();
