// Generates a 320 px JPEG preview used by photo-service/scripts/excel-load-test.js.
// The load test needs a realistic preview file because the Excel export embeds the
// preview, not the original photo.
//
//   node tests/make-preview-fixture.mjs fixture.jpg
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node tests/make-preview-fixture.mjs <output.jpg>');
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const base64 = await page.evaluate(() => {
    const source = document.createElement('canvas');
    source.width = 1200;
    source.height = 900;
    const context = source.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 1200, 900);
    gradient.addColorStop(0, '#204a3c');
    gradient.addColorStop(1, '#d9c08a');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1200, 900);
    for (let index = 0; index < 400; index += 1) {
      context.fillStyle = `rgba(${index % 255}, ${(index * 7) % 255}, ${(index * 13) % 255}, 0.5)`;
      context.fillRect((index * 37) % 1200, (index * 61) % 900, 40, 30);
    }
    const preview = document.createElement('canvas');
    preview.width = 320;
    preview.height = 240;
    preview.getContext('2d').drawImage(source, 0, 0, 320, 240);
    return preview.toDataURL('image/jpeg', 0.7).split(',')[1];
  });
  const buffer = Buffer.from(base64, 'base64');
  await writeFile(target, buffer);
  console.log(`wrote ${target}: ${(buffer.length / 1024).toFixed(1)} KB`);
} finally {
  await browser.close();
}
