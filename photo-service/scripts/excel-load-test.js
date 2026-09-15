// Load check for the full Excel export.
//
// The production estimate is about 11 701 required photos (812 stops + 427x2 PP +
// 10 035 entrances), so the export must survive that volume without running out of
// memory. This script builds a synthetic report of the requested size, writes real
// JPEG files into a temporary media root and re-opens the produced workbook.
//
// The export embeds the stored preview, so pass a 320 px preview as --image to measure
// the real workbook size. Measured on 2026-09-15: 11 701 originals of ~80 KB produced
// an 872 MB workbook and a 3.9 GB peak RSS, which is why previews are embedded instead.
//
//   node scripts/excel-load-test.js --objects=11701 --photos-per-object=1
//   node scripts/excel-load-test.js --objects=11701 --image=C:\path\to\preview.jpg
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function option(name, fallback) {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return value ? Number(value.slice(name.length + 3)) : fallback;
}

function textOption(name) {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : null;
}

const objectCount = option('objects', 11701);
const photosPerObject = option('photos-per-object', 1);
const imagePath = textOption('image');
const mediaRoot = await mkdtemp(join(tmpdir(), 'sao-excel-load-'));
process.env.PHOTO_SERVICE_MEDIA_ROOT = mediaRoot;

// Smallest valid JPEG by default; pass --image= for a realistic camera-sized photo.
const JPEG = imagePath
  ? await readFile(imagePath)
  : Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  );

const { buildExcel, buildPdf } = await import('../src/exports.js');

const rows = [];
for (let index = 0; index < objectCount; index += 1) {
  const photos = [];
  for (let n = 0; n < photosPerObject; n += 1) {
    const storageKey = `${randomUUID()}.jpg`;
    await writeFile(join(mediaRoot, storageKey), JPEG);
    photos.push({
      id: storageKey,
      storageKey,
      thumbnailKey: storageKey,
      mimeType: 'image/jpeg',
      originalFilename: `IMG_${index}_${n}.jpg`,
      byteSize: JPEG.length,
      performer: 'Иванов И.',
      comment: 'Нагрузочная проверка выгрузки.',
      capturedAt: '2026-09-15T10:00:00.000Z',
      uploadedAt: '2026-09-15T10:01:00.000Z',
      gpsLatitude: 55.81, gpsLongitude: 37.51, gpsAccuracyM: 4, distanceM: 8.2,
      geoStatus: 'within_radius', reviewStatus: 'confirmed', reviewReason: null, isReference: false,
    });
  }
  rows.push({
    object_key: `load|stop|${index}`,
    dataset_id: 'sao_stops',
    object_type: 'stop',
    report_key: `stop:${index}`,
    source_ids: [`stop:${index}`],
    district: index % 3 === 0 ? null : 'Аэропорт',
    label: `Объект ${index}`,
    reference_points: [],
    properties: {},
    source_version: 'excel-load-test',
    confirmedPhotos: photosPerObject,
    pendingReviewPhotos: 0,
    geoRisk: false,
    photos,
  });
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

const startedAt = Date.now();
const buffer = await buildExcel(rows);
const excelMs = Date.now() - startedAt;
const peakRss = process.memoryUsage().rss;

const reloadStartedAt = Date.now();
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(buffer);
const reloadMs = Date.now() - reloadStartedAt;
const objectRows = workbook.getWorksheet('Объекты').rowCount - 1;

const pdfStartedAt = Date.now();
const pdf = await buildPdf(rows);
const pdfMs = Date.now() - pdfStartedAt;

console.log(JSON.stringify({
  objects: objectCount,
  photos: objectCount * photosPerObject,
  sourcePhotoKb: Math.round(JPEG.length / 1024),
  excelBytes: buffer.length,
  excelSize: megabytes(buffer.length),
  excelSeconds: Number((excelMs / 1000).toFixed(1)),
  reloadSeconds: Number((reloadMs / 1000).toFixed(1)),
  peakRss: megabytes(peakRss),
  objectRows,
  pdfBytes: pdf.length,
  pdfSeconds: Number((pdfMs / 1000).toFixed(1)),
}, null, 2));

// A truncated workbook would still load, so the row count is asserted explicitly.
if (objectRows !== objectCount) {
  throw new Error(`expected ${objectCount} object rows, workbook contains ${objectRows}`);
}

await rm(mediaRoot, { recursive: true, force: true });
