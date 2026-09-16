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

test('лист «На штаб»: отметки по категориям, строка «АвД САО» и ИТОГО', async () => {
  // Один переход ОДХ — десятки координатных записей, и снимается каждая.
  const crossing = { ...reportRow('pp', 'Аэропорт', 1, 0, 3), object_key: 'a-pp' };
  crossing.coveredPoints = 1;

  const rows = [
    { ...reportRow('stop', 'Аэропорт', 1), object_key: 'a-stop' },
    crossing,
    // Остановка стоит в Коптеве, но балансодержатель — «АвД САО»: счёт идёт АвД.
    { ...reportRow('stop', 'Коптево', 0), object_key: 'k-stop', balance_holder: 'АвД САО' },
    { ...reportRow('entrance', 'Сокол', 0), object_key: 's-entrance' },
    // Объект без района приписать конкретному району нельзя — он тоже идёт АвД.
    { ...reportRow('stop', null, 0), object_key: 'n-stop' },
  ];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel(rows));
  const sheet = workbook.getWorksheet('На штаб');

  // Шапка: номер, район, три категории и итог; в каждой категории План, Факт, %.
  assert.equal(sheet.getCell('A1').value, '№');
  assert.equal(sheet.getCell('B1').value, 'Район');
  assert.equal(sheet.getCell('C1').value, 'Автобусные остановки');
  assert.equal(sheet.getCell('F1').value, 'Пеш.переход');
  assert.equal(sheet.getCell('I1').value, 'Подъезды (Вх. гр.)');
  assert.equal(sheet.getCell('L1').value, 'Итого');
  assert.equal(sheet.getCell('C2').value, 'План');
  assert.equal(sheet.getCell('E2').value, '%');
  assert.equal(sheet.getCell('N2').value, '%');

  // Районы по алфавиту, «АвД САО» — последней строкой перед ИТОГО.
  assert.equal(sheet.getCell('A3').value, 1);
  assert.equal(sheet.getCell('B3').value, 'Аэропорт');
  assert.equal(sheet.getCell('B4').value, 'Сокол');
  assert.equal(sheet.getCell('A5').value, 3);
  assert.equal(sheet.getCell('B5').value, 'АвД САО');

  // Аэропорт: остановка закрыта, переход — одна отметка из трёх.
  assert.equal(sheet.getCell('C3').value, 1);
  assert.equal(sheet.getCell('D3').value, 1);
  assert.equal(sheet.getCell('E3').value, 100);
  assert.equal(sheet.getCell('F3').value, 3);
  assert.equal(sheet.getCell('G3').value, 1);
  // Проценты округляются до целого: 1 из 3 — это 33 %.
  assert.equal(sheet.getCell('H3').value, 33);

  // У Сокола остановок нет, а остановки Коптева и объекта без района — у АвД.
  assert.equal(sheet.getCell('C4').value, 0);
  assert.equal(sheet.getCell('C5').value, 2);
  assert.equal(sheet.getCell('D5').value, 0);

  // ИТОГО по САО: семь отметок, закрыто две — 29 %.
  assert.equal(sheet.getCell('A6').value, 'ИТОГО по САО');
  assert.equal(sheet.getCell('L6').value, 7);
  assert.equal(sheet.getCell('M6').value, 2);
  assert.equal(sheet.getCell('N6').value, 29);
  // У Сокола остановок нет: процент показывается нулём, а не пустой ячейкой.
  assert.equal(sheet.getCell('E4').value, 0);
});

test('лист «На штаб»: вторая таблица собирается формулой SORT, ниже — комментарий', async () => {
  const rows = [
    { ...reportRow('stop', 'Беговой', 1), object_key: 'b-stop' },
    { ...reportRow('stop', 'Войковский', 0), object_key: 'v-stop' },
    { ...reportRow('stop', 'Головинский', 0), object_key: 'g-stop' },
  ];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel(rows));
  const sheet = workbook.getWorksheet('На штаб');

  // Вторая таблица идёт через три пустые строки, с той же шапкой.
  assert.equal(sheet.getCell('A10').value, '№');
  assert.equal(sheet.getCell('C10').value, 'Автобусные остановки');
  assert.equal(sheet.getCell('C11').value, 'План');

  // Числа второй таблицы отсортированы по «Итого: факт» и собраны формулой.
  const anchor = sheet.getCell('B12').value;
  assert.equal(anchor.formula, 'SORT(B3:N5,12,0)');
  assert.equal(anchor.ref, 'B12:N14');
  assert.equal(sheet.getCell('B12').result ?? anchor.result, 'Беговой');
  assert.equal(sheet.getCell('B13').value, 'Войковский');
  assert.equal(sheet.getCell('B14').value, 'Головинский');
  assert.equal(sheet.getCell('M12').value, 1);

  // ИТОГО второй таблицы повторяет первую.
  assert.equal(sheet.getCell('A15').value, 'ИТОГО по САО');
  assert.equal(sheet.getCell('L15').value, 3);
  assert.equal(sheet.getCell('M15').value, 1);

  // Комментарий для рассылки: районы без единой закрытой отметки.
  assert.equal(sheet.getCell('A17').value, 'Комментарий для рассылки (готов к отправке):');
  assert.equal(sheet.getCell('A18').value, 'Коллеги, добрый день!');
  assert.equal(sheet.getCell('A19').value, 'Слабая динамика по оцифровке объектов!');
  assert.equal(sheet.getCell('A20').value, 'Следующим районам срочно приступить к данной задаче:');
  assert.equal(sheet.getCell('A21').value, 'Войковский');
  assert.equal(sheet.getCell('A22').value, 'Головинский');
});

test('проценты «На штаб» подсвечены светофором: ноль, до 33, до 66, от 66', async () => {
  const rows = [
    { ...reportRow('stop', 'Беговой', 1), object_key: 'b-stop' },
    { ...reportRow('stop', 'Сокол', 0), object_key: 's-stop' },
  ];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel(rows));
  const sheet = workbook.getWorksheet('На штаб');

  // Светофор стоит на всех четырёх столбцах «%» в обеих таблицах.
  const refs = sheet.conditionalFormattings.map((block) => block.ref);
  for (const column of ['E', 'H', 'K', 'N']) {
    assert.ok(refs.includes(`${column}3:${column}5`), `${column}: ${refs.join(', ')}`);
    assert.ok(refs.includes(`${column}11:${column}13`), `${column}: ${refs.join(', ')}`);
  }

  const [firstBlock] = sheet.conditionalFormattings;
  assert.deepEqual(firstBlock.rules.map((rule) => rule.formulae[0]), [
    'AND($C3>0,ISNUMBER($E3),$E3<=0)',
    'AND($C3>0,ISNUMBER($E3),AND($E3>0,$E3<33))',
    'AND($C3>0,ISNUMBER($E3),AND($E3>=33,$E3<66))',
    'AND($C3>0,ISNUMBER($E3),$E3>=66)',
  ]);
  assert.deepEqual(firstBlock.rules.map((rule) => rule.style.fill.fgColor.argb), [
    'FFEA9999', 'FFF4CCCC', 'FFFFF2CC', 'FFD9EAD3',
  ]);

  // Табличные ячейки выровнены по центру и середине, рамка со всех сторон.
  const cell = sheet.getCell('C3');
  assert.equal(cell.alignment.horizontal, 'center');
  assert.equal(cell.alignment.vertical, 'middle');
  for (const side of ['top', 'left', 'bottom', 'right']) assert.equal(cell.border[side].style, 'thin');
  assert.equal(sheet.getCell('B3').alignment.horizontal, 'center');
});

test('отдельная выгрузка малой таблицы несёт только лист «На штаб»', async () => {
  const rows = [{ ...reportRow('stop', 'Аэропорт', 1), object_key: 'stop-1' }];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildHeadquartersExcel(rows));

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['На штаб']);
});
