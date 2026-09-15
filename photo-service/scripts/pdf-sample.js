// Собирает образец PDF-сводки на синтетических данных, чтобы посмотреть, что в нём напечатано.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mediaRoot = await mkdtemp(join(tmpdir(), 'sao-pdf-sample-'));
process.env.PHOTO_SERVICE_MEDIA_ROOT = mediaRoot;

const { buildPdf, buildExcel } = await import('../src/exports.js');

function row(district, objectType, index, confirmed) {
  return {
    object_key: `${objectType}|${index}`,
    dataset_id: 'sao_stops',
    object_type: objectType,
    report_key: `${objectType}:${index}`,
    source_ids: [`${objectType}:${index}`],
    district,
    label: `Объект ${index}`,
    reference_points: [],
    properties: {},
    source_version: 'embedded-map-2026-09-15',
    confirmedPhotos: confirmed,
    pendingReviewPhotos: 0,
    geoRisk: false,
    photos: [],
  };
}

const rows = [
  row('Аэропорт', 'stop', 1, 1),
  row('Аэропорт', 'stop', 2, 0),
  row('Аэропорт', 'pp', 3, 1),
  row('Сокол', 'stop', 4, 1),
  row('Сокол', 'entrance', 5, 0),
  row('Сокол', 'entrance', 6, 0),
  row(null, 'pp', 7, 0),
  row(null, 'stop', 8, 0),
];

const pdf = await buildPdf(rows);
const target = join(mediaRoot, 'sample.pdf');
await writeFile(target, pdf);
console.log(`PDF: ${target} (${pdf.length} байт)`);

const excel = await buildExcel(rows);
await writeFile(join(mediaRoot, 'sample.xlsx'), excel);
console.log(`XLSX: ${join(mediaRoot, 'sample.xlsx')} (${excel.length} байт)`);
