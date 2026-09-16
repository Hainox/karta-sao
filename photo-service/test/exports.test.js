import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { buildExcel, buildHeadquartersExcel, buildPdf } from '../src/exports.js';
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

// Одна запись источника — одна отметка; у ПП их бывает много на один объект.
function reportRow(objectType, district, confirmed, pending = 0, points = 1) {
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
    sourcePointCount: points,
    coveredPoints: confirmed + pending > 0 ? points : 0,
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
  // Статус не важен: нарушение определяется расстоянием до объекта.
  overflow.photos = [photo({ id: 'p-overflow', sha256: 'hash-overflow', geoStatus: 'review', distanceM: 34.4 })];

  const duplicateA = reportRow('entrance', 'Ховрино', 0);
  duplicateA.object_key = 'object-2';
  duplicateA.photos = [photo({ id: 'p-dup-a', sha256: 'hash-shared' })];

  const duplicateB = reportRow('entrance', 'Ховрино', 0);
  duplicateB.object_key = 'object-3';
  duplicateB.photos = [photo({ id: 'p-dup-b', sha256: 'hash-shared' })];

  const clean = reportRow('stop', 'Аэропорт', 1);
  clean.object_key = 'object-4';
  clean.photos = [photo({ id: 'p-clean', sha256: 'hash-clean' })];

  // Позиция, полученная по IP: одна точка на город, точность в сотни километров.
  const unreliable = reportRow('stop', 'Аэропорт', 0);
  unreliable.object_key = 'object-5';
  unreliable.photos = [photo({ id: 'p-unreliable', sha256: 'hash-unreliable', gpsAccuracyM: 1586473.47, distanceM: 5000 })];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel([overflow, duplicateA, duplicateB, clean, unreliable]));

  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ['Обзор', 'На штаб', 'Районы', 'Динамика', 'Риск', 'Объекты', 'Фотографии'],
  );

  const riskSheet = workbook.getWorksheet('Риск');
  assert.equal(riskSheet.getCell('A1').value, '№');
  assert.equal(riskSheet.getCell('C1').value, 'Категория');
  assert.equal(riskSheet.getCell('O1').value, 'Фото');
  // Шапка, превышение зоны, две строки дубля и недостоверная геопривязка.
  assert.equal(riskSheet.rowCount, 5);

  const categories = [2, 3, 4, 5].map((row) => riskSheet.getCell(`C${row}`).value);
  assert.ok(categories.includes('Превышение зоны'));
  assert.ok(categories.includes('Дубль фото на разных объектах'));
  assert.ok(categories.includes('Недостоверная геопривязка'));

  const overflowRow = categories.indexOf('Превышение зоны') + 2;
  // 34.4 м при границе зоны 30 м — превышение 4.4 м.
  assert.equal(riskSheet.getCell(`N${overflowRow}`).value, 4.4);
  assert.equal(riskSheet.getCell(`E${overflowRow}`).value, 'Жилищник «Ховрино»');
  assert.equal(riskSheet.getCell(`G${overflowRow}`).value, '10002217');
  assert.equal(riskSheet.getCell(`P${overflowRow}`).value, 'Риск');

  // Обычная фиксация в риски не попадает.
  assert.equal(riskSheet.rowCount - 1, 4);
});

test('лист «На штаб» даёт процент выполнения по каждому типу объектов', async () => {
  const rows = [
    { ...reportRow('stop', 'Аэропорт', 1), object_key: 'stop-1' },
    { ...reportRow('stop', 'Аэропорт', 0), object_key: 'stop-2' },
    { ...reportRow('pp', 'Аэропорт', 1), object_key: 'pp-1' },
    { ...reportRow('entrance', 'Ховрино', 1), object_key: 'entrance-1' },
  ];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel(rows));
  const sheet = workbook.getWorksheet('На штаб');

  // У каждой категории свои План, Факт и процент.
  assert.equal(sheet.getCell('C3').value, 'План');
  assert.equal(sheet.getCell('E3').value, '%');

  // Аэропорт: две отметки остановок, фото на одной — 50 %; переход с фото — 100 %.
  assert.equal(sheet.getCell('A4').value, 'Жилищник «Аэропорт»');
  assert.equal(sheet.getCell('C4').value, 2);
  assert.equal(sheet.getCell('D4').value, 1);
  assert.equal(sheet.getCell('E4').value, 50);
  assert.equal(sheet.getCell('F4').value, 1);
  assert.equal(sheet.getCell('H4').value, 100);

  // ИТОГО: четыре отметки, фото у трёх — 75 %.
  assert.equal(sheet.getCell('A7').value, 'ИТОГО по САО');
  assert.equal(sheet.getCell('L7').value, 4);
  assert.equal(sheet.getCell('M7').value, 3);
  assert.equal(sheet.getCell('N7').value, 75);
});

test('лист «На штаб» считает отметки точек, а не уникальные объекты', async () => {
  // Один переход ОДХ — десятки координатных записей, и снимается каждая.
  const crossing = { ...reportRow('pp', 'Коптево', 2), object_key: 'pp-crossing' };
  crossing.sourcePointCount = 43;
  crossing.coveredPoints = 2;

  const untouched = { ...reportRow('pp', 'Коптево', 0), object_key: 'pp-untouched' };
  untouched.sourcePointCount = 5;
  untouched.coveredPoints = 0;

  const stop = { ...reportRow('stop', 'Коптево', 1), object_key: 'stop-1' };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel([crossing, untouched, stop]));
  const sheet = workbook.getWorksheet('На штаб');

  // ПП Коптево: 48 отметок в плане, 2 закрыто — 4,2 %.
  assert.equal(sheet.getCell('A4').value, 'Жилищник «Коптево»');
  assert.equal(sheet.getCell('F4').value, 48);
  assert.equal(sheet.getCell('G4').value, 2);
  assert.equal(sheet.getCell('H4').value, 4.2);

  // Остановка Коптево: одна отметка, она же с фото.
  assert.equal(sheet.getCell('C4').value, 1);
  assert.equal(sheet.getCell('D4').value, 1);
  assert.equal(sheet.getCell('E4').value, 100);

  // ИТОГО по САО: 49 отметок, 3 закрыто — 6,1 %, а не 3 объекта.
  assert.equal(sheet.getCell('L6').value, 49);
  assert.equal(sheet.getCell('M6').value, 3);
  assert.equal(sheet.getCell('N6').value, 6.1);
});


test('проценты «На штаб» подсвечены светофором по порогам 33 % и 66 %', async () => {
  const rows = [
    { ...reportRow('stop', 'Коптево', 1), object_key: 'stop-1' },
    { ...reportRow('stop', 'Коптево', 0), object_key: 'stop-2' },
  ];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel(rows));
  const sheet = workbook.getWorksheet('На штаб');

  // Светофор стоит на всех четырёх столбцах «%»: три категории и итог.
  const refs = sheet.conditionalFormattings.map((block) => block.ref);
  for (const column of ['E', 'H', 'K', 'N']) {
    // Район, «Не распределено по районам» и строка ИТОГО.
    assert.ok(refs.includes(`${column}4:${column}6`), `${column}: ${refs.join(', ')}`);
  }

  const [districtBlock] = sheet.conditionalFormattings;
  assert.deepEqual(districtBlock.rules.map((rule) => rule.formulae[0]), [
    'AND(ISNUMBER($E4),$E4>=66)',
    'AND(ISNUMBER($E4),AND($E4>=33,$E4<66))',
    'AND(ISNUMBER($E4),$E4<33)',
  ]);
  assert.deepEqual(districtBlock.rules.map((rule) => rule.style.font.color.argb), [
    'FF1C7A55', 'FFB8791A', 'FFB3382B',
  ]);
});

test('отдельная выгрузка малой таблицы несёт только лист «На штаб»', async () => {
  const rows = [{ ...reportRow('stop', 'Аэропорт', 1), object_key: 'stop-1' }];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildHeadquartersExcel(rows));

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['На штаб']);
});
