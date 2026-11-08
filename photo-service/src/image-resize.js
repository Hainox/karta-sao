import { createCanvas, loadImage } from '@napi-rs/canvas';

/**
 * Пережимает изображение в JPEG с ограничением по длинной стороне.
 * Общий код для превью кадров ОДХ (1600 px) и миниатюр для таблицы (320 px).
 */
export async function resizeJpeg(bytes, { max = 1600, quality = 78 } = {}) {
  const image = await loadImage(Buffer.from(bytes));
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  return { bytes: canvas.toBuffer('image/jpeg', quality), width, height };
}
