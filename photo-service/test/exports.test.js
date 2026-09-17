import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { buildDistrictsExcel, buildExcel, buildHeadquartersExcel, buildPdf } from '../src/exports.js';
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

  assert.equal(percentLabel(33.3333333), '33 %');
  assert.equal(percentLabel(0), '0 %');
  assert.equal(percentLabel(66.6), '67 %');
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

test('сводная отчётность несёт лист «Проверки» без рисков по GPS', async () => {
  // Раньше сюда попадало превышение зоны GPS: показатель убран как необъективный,
  // поэтому в книге остаются только проверки, не связанные с геопозицией.
  const overflow = reportRow('entrance', 'Ховрино', 0);
  overflow.object_key = 'object-1';
  overflow.balance_holder = 'Жилищник «Ховрино»';
  overflow.odh_id = '10002217';
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
    ['Обзор', 'На штаб', 'Районы', 'Динамика', 'Проверки', 'Дубли', 'Объекты', 'Фотографии'],
  );

  const checksSheet = workbook.getWorksheet('Проверки');
  assert.equal(checksSheet.getCell('A1').value, '№');
  assert.equal(checksSheet.getCell('C1').value, 'Категория');
  assert.equal(checksSheet.getCell('J1').value, 'Фото');
  // Шапка и две строки дубля: превышение зоны и неточная геопривязка больше не риски.
  assert.equal(checksSheet.rowCount, 3);

  const categories = [2, 3].map((row) => checksSheet.getCell(`C${row}`).value);
  assert.deepEqual([...new Set(categories)], ['Дубль фото на разных объектах']);
  assert.equal(checksSheet.getCell('K2').value, 'Проверка');
  assert.equal(checksSheet.getCell('E2').value, 'Жилищник «Ховрино»');
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

  // Шапка: номер, район, три категории и итог; в каждой категории три столбца —
  // объекты (отметки к отработке), закрытые отметки и процент.
  assert.equal(sheet.getCell('A1').value, '№');
  assert.equal(sheet.getCell('B1').value, 'Район');
  assert.equal(sheet.getCell('C1').value, 'Автобусные остановки');
  assert.equal(sheet.getCell('F1').value, 'Пеш.переход');
  assert.equal(sheet.getCell('I1').value, 'Подъезды (Вх. гр.)');
  assert.equal(sheet.getCell('L1').value, 'Итого');
  ['C', 'F', 'I', 'L'].forEach((column) => {
    assert.equal(sheet.getCell(`${column}2`).value, 'Объекты');
    assert.equal(sheet.getCell(`${String.fromCharCode(column.charCodeAt(0) + 1)}2`).value, 'Факт');
    assert.equal(sheet.getCell(`${String.fromCharCode(column.charCodeAt(0) + 2)}2`).value, '%');
  });

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
  assert.equal(sheet.getCell('L3').value, 4);
  assert.equal(sheet.getCell('M3').value, 2);
  assert.equal(sheet.getCell('N3').value, 50);

  // У Сокола остановок нет, а остановки Коптева и объекта без района — у АвД.
  assert.equal(sheet.getCell('C4').value, 0);
  assert.equal(sheet.getCell('I4').value, 1);
  assert.equal(sheet.getCell('C5').value, 2);
  assert.equal(sheet.getCell('D5').value, 0);
  assert.equal(sheet.getCell('E5').value, 0);

  // ИТОГО по САО: семь отметок, закрыто две — 29 %.
  assert.equal(sheet.getCell('A6').value, 'ИТОГО по САО');
  assert.equal(sheet.getCell('L6').value, 7);
  assert.equal(sheet.getCell('M6').value, 2);
  assert.equal(sheet.getCell('N6').value, 29);
  // У Сокола остановок нет: процент показывается нулём, а не пустой ячейкой.
  assert.equal(sheet.getCell('E4').value, 0);
  // Светофор записан и в сами ячейки: у АвД 0 % при плане 2 — тёмно-красный,
  // а где плана нет, ячейка остаётся белой.
  assert.equal(sheet.getCell('E5').fill.fgColor.argb, 'FFEA9999');
  assert.equal(sheet.getCell('E4').fill.fgColor.argb, 'FFFFFFFF');
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
  assert.equal(sheet.getCell('C11').value, 'Объекты');

  // Числа второй таблицы отсортированы по «Итого, %» и собраны формулой.
  const anchor = sheet.getCell('B12').value;
  assert.equal(anchor.formula, 'SORT(B3:N5,13,0)');
  assert.equal(anchor.ref, 'B12:N14');
  assert.equal(sheet.getCell('B12').result ?? anchor.result, 'Беговой');
  assert.equal(sheet.getCell('B13').value, 'Войковский');
  assert.equal(sheet.getCell('B14').value, 'Головинский');
  assert.equal(sheet.getCell('M12').value, 1);

  // ИТОГО второй таблицы повторяет первую.
  assert.equal(sheet.getCell('A15').value, 'ИТОГО по САО');
  assert.equal(sheet.getCell('L15').value, 3);
  assert.equal(sheet.getCell('M15').value, 1);

  // Комментарий начинается фиксированной строкой, дальше — разбор этой выгрузки.
  assert.match(String(sheet.getCell('A17').value), /^Направление — «Оцифровка объектов САО» — \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}(:\d{2})?$/);
  assert.equal(sheet.getCell('A18').value ?? '', '');
  assert.equal(sheet.getCell('A19').value, 'Коллеги, добрый день!');
  assert.equal(sheet.getCell('A20').value, 'Оцифровка объектов САО: 1 из 3 отметок — 33 %.');
  assert.equal(sheet.getCell('A21').value, 'Слабая динамика по оцифровке объектов! Следующим районам срочно приступить к данной задаче:');
  assert.equal(sheet.getCell('A22').value, 'Войковский');
  assert.equal(sheet.getCell('A23').value, 'Головинский');
  assert.equal(sheet.getCell('A24').value, 'Больше всего закрыто: Беговой — 100 %.');
  assert.equal(sheet.getCell('A25').value, 'По категориям: остановки 33 %.');
  assert.equal(sheet.getCell('A26').value, 'Слабее всего — остановки (33 %).');
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

test('единая выгрузка по районам: сводка, эталонный лист и лист на каждый район', async () => {
  // Покрытие задаётся по отметкам явно: 9 из 26, 11 из 31, 60 из 100 и ноль из 43.
  const rows = [
    { ...reportRow('stop', 'Головинский', 1, 0, 26), object_key: 'g-stop', coveredPoints: 9 },
    { ...reportRow('pp', 'Головинский', 1, 0, 31), object_key: 'g-pp', coveredPoints: 11 },
    { ...reportRow('stop', 'Аэропорт', 0, 0, 43), object_key: 'a-stop', coveredPoints: 0 },
    // Объект владельца: считается АвД, а не району, где стоит.
    { ...reportRow('stop', 'Коптево', 1, 0, 100), object_key: 'k-stop', balance_holder: 'АвД САО', coveredPoints: 60 },
  ];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildDistrictsExcel(rows));
  const names = workbook.worksheets.map((sheet) => sheet.name);

  // Сверху три сводных листа, дальше — по листу на район.
  assert.deepEqual(names.slice(0, 3), ['Сводка по районам', 'На штаб', 'Дубли']);
  assert.ok(names.includes('Головинский') && names.includes('Аэропорт') && names.includes('АвД САО'), names.join(', '));

  const summary = workbook.getWorksheet('Сводка по районам');
  assert.equal(summary.getCell('B1').value, 'Район');
  assert.equal(summary.getCell('D1').value, 'Отметок к отработке');
  // Районы идут от лучших к худшим: АвД 60 %, Головинский 35 %, Аэропорт 0 %.
  assert.equal(summary.getCell('B2').value, 'АвД САО');
  assert.equal(summary.getCell('B3').value, 'Головинский');
  assert.equal(summary.getCell('B4').value, 'Аэропорт');
  // Отметки и процент совпадают со штабной моделью.
  assert.equal(summary.getCell('D3').value, 57);
  assert.equal(summary.getCell('E3').value, 20);
  assert.equal(summary.getCell('F3').value, 35);
  // Строка ИТОГО замыкает сводку и повторяет штабной итог.
  const totalRow = summary.rowCount;
  assert.equal(summary.getCell(`B${totalRow}`).value, 'ИТОГО по САО');
  assert.equal(summary.getCell(`D${totalRow}`).value, 200);
  assert.equal(summary.getCell(`E${totalRow}`).value, 80);

  // Лист района: шапка района, объекты района и блок фотографий района.
  const district = workbook.getWorksheet('Головинский');
  assert.match(String(district.getCell('A1').value), /^Головинский — объектов 2, отметок 57, закрыто 20 — 35 %/);
  assert.equal(district.getCell('C2').value, 'Объект');
  assert.equal(district.getCell('F2').value, 'Отметок');
  assert.equal(district.getCell('F3').value, 26);
  assert.equal(district.getCell('G3').value, 9);
  // Объект владельца в район не попал: он на листе «АвД САО».
  assert.equal(district.getCell('F5').value, null);
  const autodor = workbook.getWorksheet('АвД САО');
  assert.equal(autodor.getCell('E3').value, 'k-stop');
});

test('единая выгрузка по районам: совпавшие имена листов разводятся, а не роняют файл', async () => {
  // Имя листа обрезается до 31 символа, поэтому два длинных названия с общим
  // началом раньше давали повторы и вся выгрузка падала с «Worksheet name already exists».
  const longA = 'Очень длинное название района номер один АА';
  const longB = 'Очень длинное название района номер один ББ';
  const rows = [
    { ...reportRow('stop', longA, 1), object_key: 'long-a' },
    { ...reportRow('stop', longB, 0), object_key: 'long-b' },
  ];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildDistrictsExcel(rows));
  const names = workbook.worksheets.map((sheet) => sheet.name);

  // Три сводных листа и по листу на каждый район.
  assert.equal(names.length, 5);
  const districtSheets = names.slice(3);
  assert.equal(new Set(districtSheets).size, 2);
  assert.ok(districtSheets.every((name) => name.length <= 31), districtSheets.join(' | '));
  // Оба района на месте, и объекты попадают каждый на свой лист.
  assert.equal(workbook.getWorksheet(districtSheets[0]).getCell('E3').value, 'long-a');
  assert.equal(workbook.getWorksheet(districtSheets[1]).getCell('E3').value, 'long-b');
});

test('район с именем служебного листа не роняет выгрузку', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildDistrictsExcel([{ ...reportRow('stop', 'На штаб', 1), object_key: 'clash' }]));

  const names = workbook.worksheets.map((sheet) => sheet.name);
  assert.deepEqual(names, ['Сводка по районам', 'На штаб', 'Дубли', 'На штаб (2)']);
  // Эталонный лист остаётся нетронутым, а район получает свой.
  assert.equal(workbook.getWorksheet('На штаб').getCell('C3').value, 1);
  assert.equal(workbook.getWorksheet('На штаб (2)').getCell('E3').value, 'clash');
});

test('пустая выборка: книга открывается без перевёрнутого диапазона формулы', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildHeadquartersExcel([]));
  const sheet = workbook.getWorksheet('На штаб');

  // Раньше здесь стояла живая формула SORT(B3:N2,13,0) с диапазоном B9:N8
  // наизнанку: сортировать было нечего, но файл открывался с ошибкой.
  let formulas = 0;
  sheet.eachRow((row) => row.eachCell((cell) => {
    if (cell.value && typeof cell.value === 'object' && cell.value.formula) formulas += 1;
  }));
  assert.equal(formulas, 0);
  assert.equal(sheet.getCell('A3').value, 'ИТОГО по САО');
  assert.equal(sheet.getCell('L3').value, 0);
  assert.equal(sheet.getCell('M3').value, 0);
});

test('лист «Проверки»: дубли по районам и исполнители внутри района', async () => {
  // Дубль — один и тот же файл на разных объектах; расстояние GPS проверок больше
  // не создаёт: показатель убран как необъективный.
  const duplicate = (id, sha, performer) => photo({ id, sha256: sha, performer });

  const hovrinoA = reportRow('entrance', 'Ховрино', 0);
  hovrinoA.object_key = 'tops-hovrino-a';
  hovrinoA.balance_holder = 'Жилищник «Ховрино»';
  hovrinoA.photos = [duplicate('h1', 'hash-hov', 'Иванов И.И.'), duplicate('h2', 'hash-hov-2', 'Иванов И.И.')];

  const hovrinoB = reportRow('entrance', 'Ховрино', 0);
  hovrinoB.object_key = 'tops-hovrino-b';
  hovrinoB.balance_holder = 'Жилищник «Ховрино»';
  hovrinoB.photos = [duplicate('h3', 'hash-hov', 'Иванов И.И.')];

  // Объект стоит в Коптеве, но владелец — «АвД САО»: строка считается за АвД.
  const autodorA = reportRow('entrance', 'Коптево', 0);
  autodorA.object_key = 'tops-autodor-a';
  autodorA.balance_holder = 'АвД САО';
  autodorA.photos = [duplicate('a1', 'hash-aut', 'Сидоров С.С.')];

  const autodorB = reportRow('entrance', 'Коптево', 0);
  autodorB.object_key = 'tops-autodor-b';
  autodorB.balance_holder = 'АвД САО';
  autodorB.photos = [duplicate('a2', 'hash-aut', 'Сидоров С.С.')];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel([hovrinoA, hovrinoB, autodorA, autodorB]));
  const sheet = workbook.getWorksheet('Дубли');

  // Блок 1 — районы по числу дублей, ниже ИТОГО.
  assert.equal(sheet.getCell('A1').value, 'Дубли по районам');
  assert.equal(sheet.getCell('A2').value, '№');
  assert.equal(sheet.getCell('B2').value, 'Район');
  assert.equal(sheet.getCell('C2').value, 'Дублей');
  assert.equal(sheet.getCell('B3').value, 'АвД САО');
  assert.equal(sheet.getCell('C3').value, 2);
  assert.equal(sheet.getCell('B4').value, 'Ховрино');
  assert.equal(sheet.getCell('C4').value, 2);
  assert.equal(sheet.getCell('A5').value, 'ИТОГО');
  assert.equal(sheet.getCell('C5').value, 4);

  // Блок 2 — исполнители по районам, у каждого района своя шапка.
  assert.equal(sheet.getCell('A7').value, 'Исполнители по районам');
  assert.equal(sheet.getCell('B8').value, 'Исполнитель');
  assert.equal(sheet.getCell('A9').value, 'АвД САО');
  assert.equal(sheet.getCell('B10').value, 'Сидоров С.С.');
  assert.equal(sheet.getCell('C10').value, 2);

  // Примечание внизу объясняет учёт района по балансодержателю.
  assert.match(String(sheet.getCell(`A${sheet.rowCount}`).value), /балансодержателю/);
  assert.match(String(sheet.getCell(`A${sheet.rowCount}`).value), /АвД САО/);
});

test('лист «Проверки» без дублей пишет одну строку', async () => {
  const clean = reportRow('stop', 'Аэропорт', 1);
  clean.object_key = 'clean-1';
  clean.photos = [photo({ id: 'p-clean', sha256: 'hash-clean' })];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildExcel([clean]));

  const sheet = workbook.getWorksheet('Дубли');
  assert.equal(sheet.getCell('A1').value, 'Дублей фото на разных объектах не найдено');
  assert.equal(sheet.rowCount, 1);
});
