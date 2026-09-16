import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { buildExcel, buildPdf } from '../src/exports.js';
import { objectTypeLabel, percentLabel, statusBandLabel } from '../src/labels.js';

function photo(overrides = {}) {
  return {
    id: 'photo-1',
    sha256: 'hash-1',
    performer: 'Керимов Р.Ш.',
    uploadedAt: '2026-09-15T12:00:00.000Z',
    geoStatus: 'within_radius',
    reviewStatus: 'pending_review',
    gpsLatitude: 55.79,
    gpsLongitude: 37.51,
    gpsAccuracyM: 3,
    distanceM: 8,
    ...overrides,
  };
}

function reportRow(objectType, district, confirmed, pending = 0) {
  return {
    object_key: `${objectType}|${district}|1`,
    dataset_id: 'sao_stops',
    object_type: objectType,
    report_key: '1',
    source_ids: ['stop:1'],
    district,
    label: 'Объект',
    reference_points: [],
    properties: {},
    source_version: 'embedded-map-2026-09-15',
    confirmedPhotos: confirmed,
    pendingReviewPhotos: pending,
    geoRisk: false,
    photos: [],
  };
}

test('report labels are Russian words, not internal codes', () => {
  assert.equal(objectTypeLabel('stop'), 'Остановки');
  assert.equal(objectTypeLabel('pp'), 'ПП');
  assert.equal(objectTypeLabel('entrance'), 'Подъезды');
  assert.equal(objectTypeLabel('unknown'), 'unknown');

  assert.equal(statusBandLabel('low'), 'Красный');
  assert.equal(statusBandLabel('middle'), 'Жёлтый');
  assert.equal(statusBandLabel('high'), 'Зелёный');
  assert.equal(statusBandLabel(null), 'нет данных');

  assert.equal(percentLabel(33.3333333), '33,3 %');
  assert.equal(percentLabel(0), '0,0 %');
  assert.equal(percentLabel(null), 'нет данных');
});

test('the PDF embeds a Cyrillic font with a ToUnicode map', async () => {
  const pdf = await buildPdf([reportRow('stop', 'Аэропорт', 1), reportRow('pp', 'Аэропорт', 0)]);
  const raw = pdf.toString('latin1');

  // A standard PDF font is written with WinAnsi and no ToUnicode table: the report
  // then renders and copies as garbage. Both markers must be present instead.
  assert.match(raw, /\/FontFile2/);
  assert.match(raw, /\/ToUnicode/);
  assert.equal(raw.includes('/Helvetica'), false);
});

test('the PDF is produced for a district scope without photos', async () => {
  const pdf = await buildPdf([reportRow('entrance', 'Сокол', 0), reportRow('entrance', 'Сокол', 0, 1)]);
  assert.ok(pdf.subarray(0, 5).toString('latin1') === '%PDF-');
  assert.match(pdf.toString('latin1'), /\/Type\s*\/Page/);
});

test('сводная отчётность несёт отдельный лист «Риск» с автоматическими категориями', async () => {
  const overflow = reportRow('entrance', 'Ховрино', 0);
  overflow.object_key = 'object-1';
  overflow.balance_holder = 'Жилищник «Ховрино»';
  overflow.odh_id = '10002217';
  overflow.photos = [photo({ id: 'p-overflow', sha256: 'hash-overflow', geoStatus: 'risk', distanceM: 34.4 })];

  const duplicateA = reportRow('entrance', 'Ховрино', 0);
  duplicateA.object_key = 'object-2';
  duplicateA.photos = [photo({ id: 'p-dup-a', sha256: 'hash-shared' })];

  const duplicateB = reportRow('entrance', 'Ховрино', 0);
  duplicateB.object_key = 'object-3';
  duplicateB.photos = [photo({ id: 'p-dup-b', sha256: 'hash-shared' })];

  const clean = reportRow('stop', 'Аэропорт', 1);
  clean.object_key = 'object-4';
  clean.photos = [photo({ id: 'p-clean', sha256: 'hash-clean' })];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel([overflow, duplicateA, duplicateB, clean]));

  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ['Обзор', 'Районы', 'Динамика', 'Риск', 'Объекты', 'Фотографии'],
  );

  const riskSheet = workbook.getWorksheet('Риск');
  assert.equal(riskSheet.getCell('A1').value, '№');
  assert.equal(riskSheet.getCell('C1').value, 'Категория');
  assert.equal(riskSheet.getCell('O1').value, 'Фото');
  // Шапка, одно превышение зоны и по одной строке на каждый объект дубля.
  assert.equal(riskSheet.rowCount, 4);

  const categories = [2, 3, 4].map((row) => riskSheet.getCell(`C${row}`).value);
  assert.ok(categories.includes('Превышение зоны'));
  assert.ok(categories.includes('Дубль фото на разных объектах'));

  const overflowRow = categories.indexOf('Превышение зоны') + 2;
  assert.equal(riskSheet.getCell(`N${overflowRow}`).value, 14.4);
  assert.equal(riskSheet.getCell(`E${overflowRow}`).value, 'Жилищник «Ховрино»');
  assert.equal(riskSheet.getCell(`G${overflowRow}`).value, '10002217');
  assert.equal(riskSheet.getCell(`P${overflowRow}`).value, 'Риск');

  // Обычная фиксация в риски не попадает.
  assert.equal(riskSheet.rowCount - 1, 3);
});
