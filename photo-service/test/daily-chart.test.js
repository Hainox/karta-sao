import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderDailyChartImage } from '../src/daily-chart.js';

function reportWithPeak(peak) {
  const dynamics = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 5 + index)).toISOString().slice(0, 10);
    return { date, uploaded: index === 12 ? peak : 0, closed: 0 };
  });
  return { date: '2026-09-18', dynamics };
}

/** Цвет пикселя в точке. */
async function pixels(png) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

test('подписи шкалы не обрезаются краем картинки', async () => {
  // Пик в пять знаков — как «5 602» на боевых данных: подпись шире левого поля,
  // и до правки она уходила за край и читалась как «602».
  const image = await pixels(renderDailyChartImage(reportWithPeak(5602)));

  let inkedColumns = 0;
  for (let x = 0; x < 20; x += 1) {
    let inked = false;
    for (let y = 0; y < image.height; y += 1) {
      const offset = (y * image.width + x) * 4;
      const [r, g, b] = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
      if (r < 240 || g < 240 || b < 240) { inked = true; break; }
    }
    if (inked) inkedColumns += 1;
  }
  assert.equal(inkedColumns, 0, 'слева от подписей должно остаться чистое поле');
});

test('картинка рисуется и для крупных чисел', async () => {
  const image = await pixels(renderDailyChartImage(reportWithPeak(123456)));
  assert.equal(image.width, 1180);
  assert.equal(image.height, 400);
  // Ни одной непустой колонки у самого края — подписи влезли целиком.
  let inked = false;
  for (let y = 0; y < image.height && !inked; y += 1) {
    const offset = (y * image.width) * 4;
    if (image.data[offset] < 240 || image.data[offset + 1] < 240 || image.data[offset + 2] < 240) inked = true;
  }
  assert.equal(inked, false, 'крайний левый столбец должен быть пустым');
});
