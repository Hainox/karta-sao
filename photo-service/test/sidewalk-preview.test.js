import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { renderPreview, PREVIEW_MAX } from '../src/tpu-points/avd-sidewalk-photos.js';

const sample = (width, height) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#345';
  context.fillRect(0, 0, width, height);
  for (let i = 0; i < 240; i += 1) {
    context.fillStyle = `hsl(${i * 7}, 70%, 50%)`;
    context.fillRect((i * 97) % width, (i * 61) % height, 120, 80);
  }
  return canvas.toBuffer('image/jpeg', 90);
};

test('превью кадра: длинная сторона 1600 px и файл в разы меньше оригинала', async () => {
  const original = sample(3000, 2000);
  const preview = await renderPreview(original);
  assert.equal(preview.width, PREVIEW_MAX);
  assert.equal(preview.height, Math.round(2000 * PREVIEW_MAX / 3000));
  assert.ok(preview.bytes.length < original.length, 'превью должно быть легче оригинала');
  assert.equal(preview.bytes.subarray(0, 2).toString('hex'), 'ffd8', 'на выходе JPEG');
});

test('превью не растягивает маленький кадр', async () => {
  const small = sample(800, 600);
  const preview = await renderPreview(small);
  assert.deepEqual([preview.width, preview.height], [800, 600]);
});

test('превью вертикального кадра ограничено по высоте', async () => {
  const preview = await renderPreview(sample(1200, 2400));
  assert.equal(preview.height, PREVIEW_MAX);
  assert.equal(preview.width, 800);
});
