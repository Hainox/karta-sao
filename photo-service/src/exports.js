import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { reportPayload } from './reports.js';
import { completionMix, uploadDynamics } from './report.js';
import { objectTypeLabel, percentLabel, statusBandLabel, OBJECT_TYPES } from './labels.js';
import { HEADQUARTERS_NOTE, headquartersBoard, headquartersComment, headquartersValues } from './headquarters.js';
import { collectRisks, riskTops, summarizeRisks } from './risks.js';
import { reportingDistrict } from './scope.js';
import {
  CHART_COLORS, bandColor, drawBarRow, drawBandChip, drawColumns, drawGauge, drawStackedBar, section,
} from './pdf-charts.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mediaRoot } from './storage.js';

// PDFKit's built-in Helvetica cannot encode Cyrillic: the text is written with a
// WinAnsi mapping and no ToUnicode table, so the report renders and copies as
// garbage. A bundled TTF with Cyrillic fixes both reading and copy-paste.
//
// Корпоративный шрифт — Century Gothic, но он коммерческий и в публичный
// репозиторий не попадает. В комплекте лежит свободный геометрический аналог,
// а свой файл подключается переменной окружения: PHOTO_SERVICE_PDF_FONT.
const BUNDLED_PDF_FONT = fileURLToPath(new URL('../assets/fonts/Jost-Regular.ttf', import.meta.url));

function resolvePdfFont(environment) {
  const custom = String(environment.PHOTO_SERVICE_PDF_FONT || '').trim();
  if (!custom) return BUNDLED_PDF_FONT;
  if (!existsSync(custom)) {
    console.warn(`PHOTO_SERVICE_PDF_FONT not found (${custom}); using the bundled font`);
    return BUNDLED_PDF_FONT;
  }
  return custom;
}

export const PDF_FONT_PATH = resolvePdfFont(process.env);
export const PDF_FONT_NAME = 'report-body';
const MARGIN = 42;
const DYNAMICS_DAYS = 14;

/* ---------------------------------------------------------------- оформление */

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
const SECTION_FONT = { bold: true, color: { argb: 'FF1F3B57' }, size: 12 };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF4F8' } };
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAFC' } };
const RISK_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBEAE5' } };
const THIN_BORDER = { style: 'thin', color: { argb: 'FFC8D6E0' } };

// Полоса в ячейке — родная визуализация Excel: масштабируется и печатается.
const PERCENT_BAR = (argb) => ({
  type: 'dataBar', minLength: 0, maxLength: 100,
  cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 100 }], color: { argb },
});

function styleHeaderRow(worksheet, columnCount, rowIndex = 1) {
  const row = worksheet.getRow(rowIndex);
  row.height = 30;
  for (let index = 1; index <= columnCount; index += 1) {
    const cell = row.getCell(index);
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: THIN_BORDER };
  }
}

function shadeRows(worksheet, lastRow, columnCount, fill = ZEBRA_FILL) {
  for (let index = 2; index <= lastRow; index += 1) {
    if (index % 2 !== 0) continue;
    for (let column = 1; column <= columnCount; column += 1) worksheet.getRow(index).getCell(column).fill = fill;
  }
}

function frameTable(worksheet, lastRow, columnCount) {
  for (let index = 1; index <= lastRow; index += 1) {
    for (let column = 1; column <= columnCount; column += 1) worksheet.getRow(index).getCell(column).border = { bottom: THIN_BORDER };
  }
}

/* -------------------------------------------------------- лист «На штаб» */

// Раскладка по эталону заказчика: номер, район, три категории и итог.
// В каждой категории три колонки: «Объекты» — отметки, которые нужно отработать
// (столько же показывает страница фотофиксации), «Факт» и «%» по отметкам.
const HEADQUARTERS_COLUMNS = Object.freeze([
  { start: 1, end: 1, title: '№', fill: 'FFD9D9D9' },
  { start: 2, end: 2, title: 'Район', fill: 'FFD9D9D9' },
  { start: 3, end: 5, title: 'Автобусные остановки', fill: 'FFC9DAF8' },
  { start: 6, end: 8, title: 'Пеш.переход', fill: 'FFD9EAD3' },
  { start: 9, end: 11, title: 'Подъезды (Вх. гр.)', fill: 'FFF9CB9C' },
  { start: 12, end: 14, title: 'Итого', fill: 'FFD9D9D9' },
]);
const HEADQUARTERS_COLUMN_COUNT = 14;
const HEADQUARTERS_WIDTHS = Object.freeze([4.71, 25.43, 14.43, 14.43, 14.43, 14.43, 14.43, 14.43, 14.43, 14.43, 14.43, 14.43, 14.43, 14.43]);

// Столбцы «%»: после каждой категории и в итоге, за два столбца до них — объекты.
// Процент показывается всегда (нулевой план даёт 0 %), но светофор такие ячейки
// не красит: где объектов этого вида нет, оценивать нечего.
const PERCENT_COLUMNS = Object.freeze([5, 8, 11, 14]);
const PERCENT_PLAN_COLUMNS = Object.freeze({ 5: 3, 8: 6, 11: 9, 14: 12 });

const HEADQUARTERS_FONT = 'Century Gothic';
const HEADQUARTERS_INK = 'FF1F3B57';
const HEADQUARTERS_MUTED = 'FF708089';

const CENTERED = Object.freeze({ horizontal: 'center', vertical: 'middle' });
const TO_LEFT = Object.freeze({ horizontal: 'left', vertical: 'middle' });
const THIN_SIDE = Object.freeze({ style: 'thin', color: { argb: 'FF000000' } });
const CELL_BORDER = Object.freeze({ top: THIN_SIDE, left: THIN_SIDE, bottom: THIN_SIDE, right: THIN_SIDE });

function solidFill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// Светофор процентов: цвета — из эталона заказчика (бледные заливки, смысл несёт
// число), пороги — те же, что у полосы статуса. Отдельный цвет у точного нуля.
const BAND_FILLS = Object.freeze({
  zero: 'FFEA9999', low: 'FFF4CCCC', middle: 'FFFFF2CC', high: 'FFD9EAD3',
});

/**
 * Заливка ячейки процента: та же градация, что в правилах условного
 * форматирования, но записанная сразу в ячейку. Цвета видно и там, где правила
 * не пересчитываются, а сами правила продолжают работать при правках данных.
 */
function percentBandFill(percent, plan) {
  if (plan <= 0) return 'FFFFFFFF';
  if (percent <= 0) return BAND_FILLS.zero;
  if (percent < 33) return BAND_FILLS.low;
  if (percent < 66) return BAND_FILLS.middle;
  return BAND_FILLS.high;
}

function percentBandRules(letter, firstRow, planLetter) {
  const cell = `$${letter}${firstRow}`;
  const plan = `$${planLetter}${firstRow}`;
  return [
    { when: `${cell}<=0`, band: 'zero' },
    { when: `AND(${cell}>0,${cell}<33)`, band: 'low' },
    { when: `AND(${cell}>=33,${cell}<66)`, band: 'middle' },
    { when: `${cell}>=66`, band: 'high' },
  ].map(({ when, band }) => ({
    type: 'expression',
    // Без плана красить нечего: у строки пустой категории цвета нет.
    formulae: [`AND(${plan}>0,ISNUMBER(${cell}),${when})`],
    style: { fill: solidFill(BAND_FILLS[band]) },
  }));
}

function paintPercentBands(worksheet, firstRow, lastRow) {
  if (lastRow < firstRow) return;
  for (const column of PERCENT_COLUMNS) {
    const letter = worksheet.getColumn(column).letter;
    const planLetter = worksheet.getColumn(PERCENT_PLAN_COLUMNS[column]).letter;
    worksheet.addConditionalFormatting({
      ref: `${letter}${firstRow}:${letter}${lastRow}`,
      rules: percentBandRules(letter, firstRow, planLetter),
    });
  }
}

/** Шапка таблицы: строка групп и строка «План / Факт / %». */
function writeHeadquartersHeader(sheet, headerRow) {
  for (const column of HEADQUARTERS_COLUMNS) {
    if (column.start === column.end) sheet.mergeCells(headerRow, column.start, headerRow + 1, column.start);
    else sheet.mergeCells(headerRow, column.start, headerRow, column.end);
    sheet.getCell(headerRow, column.start).value = column.title;
    for (let index = column.start; index <= column.end; index += 1) {
      for (const row of [headerRow, headerRow + 1]) {
        const cell = sheet.getCell(row, index);
        cell.fill = solidFill(column.fill);
        cell.border = CELL_BORDER;
        cell.alignment = CENTERED;
        cell.font = { name: HEADQUARTERS_FONT, bold: true, size: row === headerRow ? 11 : 9 };
      }
    }
    if (column.start === column.end) continue;
    ['Объекты', 'Факт', '%'].forEach((label, offset) => {
      sheet.getCell(headerRow + 1, column.start + offset).value = label;
    });
  }
}

/**
 * Таблица районов: шапка, строки, ИТОГО по САО и светофор на проценты.
 * `formula` ставит во вторую таблицу живую сортировку по «Итого: факт».
 */
function writeHeadquartersTable(sheet, headerRow, { names, counts, total, formula }) {
  const firstDataRow = headerRow + 2;
  const totalRow = firstDataRow + names.length;
  writeHeadquartersHeader(sheet, headerRow);

  names.forEach((name, index) => {
    const row = firstDataRow + index;
    const values = [index + 1, name, ...headquartersValues(counts[index])];
    values.forEach((value, offset) => {
      const column = offset + 1;
      const cell = sheet.getCell(row, column);
      cell.value = value;
      cell.fill = solidFill(PERCENT_COLUMNS.includes(column) ? percentBandFill(value, values[column - 3]) : 'FFFFFFFF');
      cell.border = CELL_BORDER;
      cell.alignment = CENTERED;
      cell.font = { name: HEADQUARTERS_FONT, size: 11, bold: PERCENT_COLUMNS.includes(column) };
      cell.numFmt = PERCENT_COLUMNS.includes(column) ? '0"%"' : '0';
    });
  });

  const totalValues = headquartersValues(total);
  sheet.mergeCells(totalRow, 1, totalRow, 2);
  sheet.getCell(totalRow, 1).value = 'ИТОГО по САО';
  for (let column = 1; column <= HEADQUARTERS_COLUMN_COUNT; column += 1) {
    const cell = sheet.getCell(totalRow, column);
    if (column > 2) cell.value = totalValues[column - 3];
    cell.fill = solidFill(PERCENT_COLUMNS.includes(column) ? percentBandFill(totalValues[column - 3], totalValues[column - 5]) : 'FFFFFFFF');
    cell.border = CELL_BORDER;
    cell.alignment = CENTERED;
    cell.font = { name: HEADQUARTERS_FONT, size: 11, bold: true };
    if (PERCENT_COLUMNS.includes(column)) cell.numFmt = '0"%"';
    else if (column > 2) cell.numFmt = '0';
  }

  // Формулу ставим только когда есть что сортировать: на пустой выборке
  // диапазон схлопывается в перевёрнутый (B3:N2) и книга открывается с ошибкой,
  // поэтому пустая доска остаётся без живого блока.
  if (formula && names.length) {
    // Значения под формулой остаются на месте: файл открывается и там, где
    // динамических массивов нет, а Excel пересчитает блок сам.
    const lastColumn = sheet.getColumn(HEADQUARTERS_COLUMN_COUNT).letter;
    sheet.getCell(firstDataRow, 2).value = {
      shareType: 'array',
      formula,
      ref: `B${firstDataRow}:${lastColumn}${totalRow - 1}`,
      result: names[0],
    };
  }

  paintPercentBands(sheet, firstDataRow, totalRow);
  return totalRow;
}

/** Готовый текст для рассылки: строки из headquartersComment. */
function writeHeadquartersComment(sheet, firstRow, lines) {
  lines.forEach((line, offset) => {
    const row = firstRow + offset;
    sheet.mergeCells(row, 1, row, HEADQUARTERS_COLUMN_COUNT);
    const cell = sheet.getCell(row, 1);
    cell.value = line;
    cell.alignment = TO_LEFT;
    cell.font = {
      name: HEADQUARTERS_FONT,
      size: offset === 0 ? 11 : 10,
      bold: offset === 0,
      color: { argb: offset === 0 ? HEADQUARTERS_INK : 'FF000000' },
    };
  });
  return firstRow + lines.length;
}

/**
 * Лист «На штаб»: короткая форма ОУИФР с процентом по каждой категории.
 * Используется и в общей книге, и в отдельной выгрузке.
 */
function addHeadquartersSheet(workbook, payload) {
  // Короткая форма ОУИФР для штаба: отметки по типам и районам, ниже — та же
  // таблица, пересортированная по «Итого: факт». Отдельный лист, чтобы «Обзор»
  // не разрастался.
  const sheet = workbook.addWorksheet('На штаб');
  HEADQUARTERS_WIDTHS.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });

  const board = headquartersBoard(payload);
  const firstTotalRow = writeHeadquartersTable(sheet, 1, board);

  // Вторая таблица — те же числа, отсортированные по «Итого: факт»: в первой
  // ячейке стоит формула SORT, поэтому блок пересобирается при правках данных.
  const secondTotalRow = writeHeadquartersTable(sheet, firstTotalRow + 4, {
    ...board,
    names: board.sorted.map((item) => item.name),
    counts: board.sorted.map((item) => item.counts),
    // 13-я колонка диапазона — «Итого, %»: та же сортировка, что и у значений ниже.
    formula: `SORT(B3:N${firstTotalRow - 1},13,0)`,
  });

  const afterComment = writeHeadquartersComment(sheet, secondTotalRow + 2, headquartersComment(board));

  const noteRow = afterComment + 1;
  sheet.mergeCells(noteRow, 1, noteRow, HEADQUARTERS_COLUMN_COUNT);
  const note = sheet.getCell(noteRow, 1);
  note.value = HEADQUARTERS_NOTE;
  note.alignment = TO_LEFT;
  note.font = { name: HEADQUARTERS_FONT, size: 8, color: { argb: HEADQUARTERS_MUTED } };
}

export async function buildHeadquartersExcel(rows) {
  const workbook = new ExcelJS.Workbook();
  addHeadquartersSheet(workbook, reportPayload(rows));
  return workbook.xlsx.writeBuffer();
}

/* ------------------------------------------------------------------ «Топы» */

const TOPS_COLUMN_COUNT = 3;
const TOPS_WIDTHS = Object.freeze([6, 36, 14]);
// Рамка той же толщины, что и у остальных листов: полная сетка на строку данных.
const TOPS_BORDER = Object.freeze({ top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER });
const TOPS_NOTE = 'Район считается по балансодержателю: объекты «АвД САО», «ДЭУ» и объекты без района учтены в строке «АвД САО».';

function topsTitleRow(sheet, row, title) {
  sheet.mergeCells(row, 1, row, TOPS_COLUMN_COUNT);
  const cell = sheet.getCell(row, 1);
  cell.value = title;
  cell.font = SECTION_FONT;
  cell.fill = SECTION_FILL;
  cell.alignment = TO_LEFT;
  sheet.getRow(row).height = 22;
}

function topsDataRow(sheet, row, values, fill) {
  values.forEach((value, offset) => {
    const cell = sheet.getCell(row, offset + 1);
    cell.value = value;
    cell.border = TOPS_BORDER;
    cell.alignment = CENTERED;
    cell.font = { size: 11 };
    if (fill) cell.fill = fill;
  });
}

/**
 * Лист «Топы»: районы по числу рисков и исполнители внутри каждого района.
 * Район считается по тому же правилу, что и строка «АвД САО» штабной таблицы.
 */
function addTopsSheet(workbook, risks) {
  const sheet = workbook.addWorksheet('Топы');
  TOPS_WIDTHS.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  const tops = riskTops(risks);
  let row = 1;

  if (!tops.total) {
    sheet.mergeCells(row, 1, row, TOPS_COLUMN_COUNT);
    const cell = sheet.getCell(row, 1);
    cell.value = 'Риски не выявлены';
    cell.font = SECTION_FONT;
    cell.fill = SECTION_FILL;
    cell.alignment = TO_LEFT;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return sheet;
  }

  // Блок 1 — районы по числу рисков, от худшего к лучшему.
  topsTitleRow(sheet, row, 'Топ районов по рискам');
  row += 1;
  styleHeaderRow(sheet, TOPS_COLUMN_COUNT, row);
  ['№', 'Район', 'Нарушений'].forEach((title, offset) => { sheet.getCell(row, offset + 1).value = title; });
  row += 1;
  tops.districts.forEach((entry, index) => {
    topsDataRow(sheet, row, [index + 1, entry.district, entry.count], index % 2 === 1 ? ZEBRA_FILL : null);
    row += 1;
  });
  sheet.mergeCells(row, 1, row, 2);
  sheet.getCell(row, 1).value = 'ИТОГО';
  for (let column = 1; column <= TOPS_COLUMN_COUNT; column += 1) {
    const cell = sheet.getCell(row, column);
    cell.fill = TOTAL_FILL;
    cell.border = TOPS_BORDER;
    cell.alignment = CENTERED;
    cell.font = { size: 11, bold: true };
  }
  sheet.getCell(row, 3).value = tops.total;
  row += 2; // Пустая строка между блоками.

  // Блок 2 — исполнители по районам: у каждого района своя шапка.
  topsTitleRow(sheet, row, 'Топ исполнителей по районам');
  row += 1;
  styleHeaderRow(sheet, TOPS_COLUMN_COUNT, row);
  ['№', 'Исполнитель', 'Нарушений'].forEach((title, offset) => { sheet.getCell(row, offset + 1).value = title; });
  row += 1;
  for (const entry of tops.districts) {
    sheet.mergeCells(row, 1, row, TOPS_COLUMN_COUNT);
    const header = sheet.getCell(row, 1);
    header.value = entry.district;
    header.font = { size: 11, bold: true, color: { argb: HEADQUARTERS_INK } };
    header.fill = SECTION_FILL;
    header.alignment = TO_LEFT;
    sheet.getRow(row).height = 18;
    row += 1;
    entry.performers.forEach((performer, index) => {
      topsDataRow(sheet, row, [index + 1, performer.performer, performer.count], index % 2 === 1 ? ZEBRA_FILL : null);
      row += 1;
    });
  }

  row += 1;
  sheet.mergeCells(row, 1, row, TOPS_COLUMN_COUNT);
  const note = sheet.getCell(row, 1);
  note.value = TOPS_NOTE;
  note.alignment = TO_LEFT;
  note.font = { size: 8, color: { argb: HEADQUARTERS_MUTED } };

  frameTable(sheet, row, TOPS_COLUMN_COUNT);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return sheet;
}

export async function buildExcel(rows) {
  const payload = reportPayload(rows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SAO photo service';
  workbook.created = new Date();
  const risks = collectRisks(payload.objects);
  const riskSummary = summarizeRisks(risks);
  const overall = payload.overall;

  const overview = workbook.addWorksheet('Обзор');
  overview.columns = [{ key: 'metric', width: 46 }, { key: 'value', width: 20 }, { key: 'note', width: 52 }];
  overview.mergeCells('A1:C1');
  overview.getCell('A1').value = 'Сводная отчётность по фотофиксации САО';
  overview.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF1F3B57' } };
  overview.mergeCells('A2:C2');
  overview.getCell('A2').value = `Сформирован: ${new Date().toLocaleString('ru-RU')} (МСК)   ·   Версия набора объектов: ${payload.sourceVersions.join(', ') || 'не указана'}`;
  overview.getCell('A2').font = { size: 9, color: { argb: 'FF708089' } };

  let overviewRow = 4;
  let coverageRow = null;
  const sectionRow = (title) => {
    overview.mergeCells(`A${overviewRow}:C${overviewRow}`);
    const cell = overview.getCell(`A${overviewRow}`);
    cell.value = title;
    cell.font = SECTION_FONT;
    cell.fill = SECTION_FILL;
    cell.alignment = { vertical: 'middle' };
    overview.getRow(overviewRow).height = 22;
    overviewRow += 1;
  };
  const metricRow = (metric, value, note = '') => {
    overview.getCell(`A${overviewRow}`).value = metric;
    overview.getCell(`B${overviewRow}`).value = value;
    overview.getCell(`B${overviewRow}`).alignment = { horizontal: 'left' };
    overview.getCell(`C${overviewRow}`).value = note;
    overview.getCell(`C${overviewRow}`).font = { size: 9, color: { argb: 'FF708089' } };
    overviewRow += 1;
  };

  sectionRow('ОХВАТ');
  const coveragePercent = overall.totalObjects ? (overall.objectsWithPhoto / overall.totalObjects) * 100 : null;
  metricRow('Объектов всего', overall.totalObjects);
  metricRow('С фото', overall.objectsWithPhoto);
  metricRow('Без фото', overall.objectsWithoutPhoto);
  coverageRow = overviewRow;
  metricRow('Охват', coveragePercent === null ? '—' : Math.round(coveragePercent), 'Доля объектов, по которым есть хотя бы одно фото');
  metricRow('Выполнено', overall.completedObjects, `Выполнение: ${percentLabel(overall.completionPercent)}`);
  metricRow('На проверке', overall.pendingReviewObjects);

  sectionRow('РИСК');
  metricRow('Выявлено всего', riskSummary.total, 'Статус присваивается автоматически по категории');
  for (const kind of riskSummary.byKind) metricRow(kind.kindLabel, kind.count);
  if (!riskSummary.total) metricRow('Рисков нет', 0, 'Ни одна фиксация не попала в категории риска');

  if (coverageRow) {
    overview.addConditionalFormatting({ ref: `B${coverageRow}:B${coverageRow}`, rules: [PERCENT_BAR('FF1C7A55')] });
  addHeadquartersSheet(workbook, payload);

  }

  const districts = payload.byDistrict;
  const risksByDistrict = new Map();
  for (const risk of risks) {
    // Риск относится к району по тому же правилу, что и строка отчёта: объекты
    // владельца, «ДЭУ» и объекты без района считаются за «АвД САО».
    const key = reportingDistrict(risk);
    risksByDistrict.set(key, (risksByDistrict.get(key) || 0) + 1);
  }
  if (districts.length > 1) {
    const districtsSheet = workbook.addWorksheet('Районы');
    districtsSheet.columns = [
      { header: 'Район', key: 'district', width: 24 },
      { header: 'Объектов', key: 'total', width: 12 },
      { header: 'С фото', key: 'withPhoto', width: 12 },
      { header: 'Охват, %', key: 'coverage', width: 12 },
      { header: 'Выполнено', key: 'completed', width: 13 },
      { header: 'На проверке', key: 'pending', width: 13 },
      { header: 'Без фото', key: 'empty', width: 12 },
      { header: 'Рисков', key: 'risks', width: 11 },
    ];
    let totals = { total: 0, withPhoto: 0, completed: 0, pending: 0, empty: 0, risks: 0 };
    for (const district of districts) {
      const parts = Object.fromEntries(completionMix(district).map((part) => [part.key, part.value]));
      const districtRisks = risksByDistrict.get(district.district) || 0;
      districtsSheet.addRow({
        district: district.district || 'Без района',
        total: district.totalObjects,
        withPhoto: district.objectsWithPhoto,
        coverage: district.totalObjects ? Math.round((district.objectsWithPhoto / district.totalObjects) * 100) : null,
        completed: district.completedObjects,
        pending: district.pendingReviewObjects,
        empty: parts.empty,
        risks: districtRisks,
      });
      totals = {
        total: totals.total + district.totalObjects,
        withPhoto: totals.withPhoto + district.objectsWithPhoto,
        completed: totals.completed + district.completedObjects,
        pending: totals.pending + district.pendingReviewObjects,
        empty: totals.empty + parts.empty,
        risks: totals.risks + districtRisks,
      };
    }
    const totalRow = districtsSheet.addRow({
      district: 'ИТОГО',
      ...totals,
      coverage: totals.total ? Math.round((totals.withPhoto / totals.total) * 100) : null,
    });
    totalRow.font = { bold: true };
    for (let column = 1; column <= 8; column += 1) totalRow.getCell(column).fill = TOTAL_FILL;

    styleHeaderRow(districtsSheet, 8);
    shadeRows(districtsSheet, districtsSheet.rowCount - 1, 8);
    frameTable(districtsSheet, districtsSheet.rowCount, 8);
    districtsSheet.views = [{ state: 'frozen', ySplit: 1 }];
    districtsSheet.autoFilter = { from: 'A1', to: 'H1' };
    const lastDistrict = districtsSheet.rowCount - 1;
    districtsSheet.addConditionalFormatting({ ref: `D2:D${lastDistrict}`, rules: [PERCENT_BAR('FF1C7A55')] });
    districtsSheet.addConditionalFormatting({ ref: `C2:C${lastDistrict}`, rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF7FB89F' } }] });
    districtsSheet.addConditionalFormatting({ ref: `H2:H${lastDistrict}`, rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [0], style: { fill: RISK_FILL, font: { color: { argb: 'FF9E2B25' }, bold: true } } }] });
  }

  const dynamics = uploadDynamics(rows, { days: DYNAMICS_DAYS });
  const dynamicsSheet = workbook.addWorksheet('Динамика');
  dynamicsSheet.columns = [
    { header: 'Дата', key: 'date', width: 14 },
    { header: 'Загружено за день', key: 'uploaded', width: 20 },
    { header: 'Всего в службе', key: 'cumulative', width: 18 },
  ];
  for (const point of dynamics) dynamicsSheet.addRow(point);
  dynamicsSheet.getRow(1).font = { bold: true };
  dynamicsSheet.views = [{ state: 'frozen', ySplit: 1 }];
  const lastDay = dynamicsSheet.rowCount;
  dynamicsSheet.addConditionalFormatting({
    ref: `B2:B${lastDay}`,
    rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF1C7A55' } }],
  });
  dynamicsSheet.addRow([]);
  dynamicsSheet.addRow([`Загружено за ${DYNAMICS_DAYS} дней`, dynamics.reduce((sum, point) => sum + point.uploaded, 0)]);
  dynamicsSheet.addRow(['Всего фиксаций', dynamics[dynamics.length - 1].cumulative]);
  styleHeaderRow(dynamicsSheet, 3);

  /* ------------------------------------------------------------------ «Риск» */
  // Отдельный пункт сводной отчётности: сюда попадает всё, что автоматически
  // отнесено к категориям риска. Ручного разбора статуса нет.
  const riskSheet = workbook.addWorksheet('Риск');
  riskSheet.columns = [
    { header: '№', key: 'index', width: 6 },
    { header: 'Дата выявления', key: 'detectedAt', width: 18 },
    { header: 'Категория', key: 'kind', width: 30 },
    { header: 'Район', key: 'district', width: 20 },
    { header: 'Балансодержатель', key: 'balanceHolder', width: 26 },
    { header: 'Объект', key: 'objectLabel', width: 46 },
    { header: 'ID объекта ОДХ', key: 'odhId', width: 16 },
    { header: 'Координаты объекта', key: 'objectPoint', width: 26 },
    { header: 'Исполнитель', key: 'performer', width: 24 },
    { header: 'Широта GPS', key: 'gpsLatitude', width: 13 },
    { header: 'Долгота GPS', key: 'gpsLongitude', width: 13 },
    { header: 'Точность GPS, м', key: 'gpsAccuracyM', width: 14 },
    { header: 'Расстояние до объекта, м', key: 'distanceM', width: 16 },
    { header: 'Превышение зоны, м', key: 'overMeters', width: 16 },
    { header: 'Фото', key: 'photo', width: 22 },
    { header: 'Статус', key: 'statusLabel', width: 12 },
  ];
  risks.forEach((risk, index) => {
    const excelRow = riskSheet.addRow({
      index: index + 1,
      detectedAt: risk.detectedAt ? new Date(risk.detectedAt).toLocaleString('ru-RU') : '—',
      kind: risk.kindLabel,
      district: risk.district || '—',
      balanceHolder: risk.balanceHolder || '—',
      objectLabel: risk.objectLabel || '—',
      odhId: risk.odhId || '—',
      objectPoint: risk.objectPoint ? `${risk.objectPoint.latitude.toFixed(6)}, ${risk.objectPoint.longitude.toFixed(6)}` : '—',
      performer: risk.performer || '—',
      gpsLatitude: risk.gps.latitude ?? '—',
      gpsLongitude: risk.gps.longitude ?? '—',
      gpsAccuracyM: risk.gps.accuracyM ?? '—',
      distanceM: risk.distanceM === null ? '—' : Number(risk.distanceM.toFixed(1)),
      overMeters: risk.overMeters === null ? '—' : risk.overMeters,
      statusLabel: risk.statusLabel,
    });
    excelRow.height = 78;
  });
  let riskImageRow = 1;
  for (const risk of risks) {
    const file = (risk.photoFiles || [])[0];
    const key = file ? (file.thumbnailKey || file.storageKey) : null;
    if (key) {
      try {
        // Встраивается только превью: оригиналы делают книгу несоразмерно тяжёлой.
        const buffer = await readFile(`${mediaRoot()}/${key}`);
        const imageId = workbook.addImage({ buffer, extension: key.endsWith('.png') ? 'png' : key.endsWith('.webp') ? 'webp' : 'jpeg' });
        riskSheet.addImage(imageId, { tl: { col: 14, row: riskImageRow }, ext: { width: 150, height: 100 } });
      } catch {
        // Метаданные остаются в строке, даже если файл недоступен.
      }
    }
    riskImageRow += 1;
  }
  styleHeaderRow(riskSheet, 16);
  shadeRows(riskSheet, riskSheet.rowCount, 16);
  frameTable(riskSheet, riskSheet.rowCount, 16);
  riskSheet.views = [{ state: 'frozen', ySplit: 1 }];
  riskSheet.autoFilter = { from: 'A1', to: 'P1' };

  // Топы по нарушениям: районы и исполнители внутри района.
  addTopsSheet(workbook, risks);

  const objects = workbook.addWorksheet('Объекты');
  const risksByObject = new Map();
  for (const risk of risks) {
    if (!risk.objectKey) continue;
    risksByObject.set(risk.objectKey, (risksByObject.get(risk.objectKey) || 0) + 1);
  }

  objects.columns = [
    { header: 'Район', key: 'district', width: 20 }, { header: 'Тип', key: 'objectType', width: 14 },
    { header: 'Объект', key: 'label', width: 42 }, { header: 'Балансодержатель', key: 'balanceHolder', width: 26 },
    { header: 'Ключ', key: 'objectKey', width: 42 },
    { header: 'Подтверждено', key: 'confirmed', width: 16 }, { header: 'На проверке', key: 'pending', width: 14 },
    { header: 'GPS-риск', key: 'geoRisk', width: 12 }, { header: 'Рисков', key: 'risks', width: 10 },
  ];
  for (const row of payload.objects) {
    objects.addRow({ district: row.district || 'Без района', objectType: objectTypeLabel(row.objectType), label: row.label,
      balanceHolder: row.balanceHolder || '—', objectKey: row.objectKey,
      confirmed: row.confirmedPhotos, pending: row.pendingReviewPhotos,
      geoRisk: row.geoRisk ? 'Да' : 'Нет', risks: risksByObject.get(row.objectKey) || 0 });
  }
  styleHeaderRow(objects, 9);
  shadeRows(objects, objects.rowCount, 9);
  frameTable(objects, objects.rowCount, 9);
  objects.views = [{ state: 'frozen', ySplit: 1 }];
  objects.autoFilter = { from: 'A1', to: 'I1' };
  const photos = workbook.addWorksheet('Фотографии');
  photos.columns = [
    { header: 'Район', key: 'district', width: 20 }, { header: 'Тип', key: 'objectType', width: 14 },
    { header: 'Объект', key: 'label', width: 38 }, { header: 'Статус проверки', key: 'reviewStatus', width: 20 },
    { header: 'GPS', key: 'geoStatus', width: 18 }, { header: 'Дистанция, м', key: 'distanceM', width: 14 },
    { header: 'Исполнитель', key: 'performer', width: 24 }, { header: 'Комментарий', key: 'comment', width: 42 },
    { header: 'Имя файла', key: 'filename', width: 30 },
  ];
  let rowNumber = 2;
  for (const object of payload.objects) {
    for (const photo of object.photos) {
      const excelRow = photos.addRow({ district: object.district || 'Без района', objectType: objectTypeLabel(object.objectType),
        label: object.label, reviewStatus: photo.reviewStatus, geoStatus: photo.geoStatus,
        distanceM: photo.distanceM ?? '—', performer: photo.performer, comment: photo.comment,
        filename: photo.originalFilename });
      excelRow.height = 100;
      try {
        // Only the small preview is embedded: the full set of originals produces a
        // workbook of several hundred megabytes. The original stays on the server.
        // The extension comes from the stored key because a preview is always JPEG
        // even when the original was uploaded as PNG or WebP.
        const key = photo.thumbnailKey || photo.storageKey;
        const buffer = await readFile(`${mediaRoot()}/${key}`);
        const imageId = workbook.addImage({ buffer, extension: key.endsWith('.png') ? 'png' : key.endsWith('.webp') ? 'webp' : 'jpeg' });
        photos.addImage(imageId, { tl: { col: 9, row: rowNumber - 1 }, ext: { width: 150, height: 90 } });
      } catch {
        // Metadata remains exportable when a media file is unavailable; the row is still visible for audit.
      }
      rowNumber += 1;
    }
  }
  styleHeaderRow(photos, 10);
  frameTable(photos, photos.rowCount, 10);
  photos.views = [{ state: 'frozen', ySplit: 1 }];
  photos.autoFilter = { from: 'A1', to: 'J1' };
  return workbook.xlsx.writeBuffer();
}

/* ------------------------------------------------- выгрузка по районам */

// Имя листа Excel ограничено 31 символом и не терпит []:*?/\ — названия районов
// проходят как есть, проверка нужна на случай правок в источнике. Кавычку по
// краям Excel тоже не принимает, а длинное имя обрезается: два названия,
// совпавшие после обрезки, разведём отдельно — иначе падает вся выгрузка.
function districtSheetName(name) {
  return String(name).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').slice(0, 31).trim() || 'Район';
}

/** Свободное имя листа: ExcelJS падает на повторе, а сравнение у него без регистра. */
function uniqueSheetName(workbook, name) {
  const taken = (candidate) => workbook.worksheets
    .some((sheet) => sheet.name.toLowerCase() === candidate.toLowerCase());
  let candidate = name;
  for (let suffix = 2; taken(candidate); suffix += 1) {
    const tail = ` (${suffix})`;
    candidate = name.slice(0, 31 - tail.length).trim() + tail;
  }
  return candidate;
}

/** Объекты набора, сгруппированные по району отчётности (с учётом строки «АвД САО»). */
function objectsByReportingDistrict(objects) {
  const grouped = new Map();
  for (const object of objects) {
    const key = reportingDistrict(object);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(object);
  }
  return grouped;
}

/**
 * Сводный лист «Сводка по районам»: объекты, отметки и процент по каждому району.
 * Отметки берутся из штабной модели, поэтому числа совпадают с листом «На штаб»,
 * картинкой для Telegram и PDF, а строки отсортированы от лучших к худшим.
 */
function addDistrictSummarySheet(workbook, payload, board, risksByDistrict) {
  const sheet = workbook.addWorksheet('Сводка по районам');
  sheet.columns = [
    { header: '№', key: 'index', width: 6 },
    { header: 'Район', key: 'district', width: 24 },
    { header: 'Объектов', key: 'objects', width: 12 },
    { header: 'Отметок к отработке', key: 'plan', width: 18 },
    { header: 'Закрыто отметок', key: 'fact', width: 17 },
    { header: '%', key: 'percent', width: 8 },
    { header: 'С фото', key: 'withPhoto', width: 11 },
    { header: 'Охват, %', key: 'coverage', width: 11 },
    { header: 'На проверке', key: 'pending', width: 13 },
    { header: 'Рисков', key: 'risks', width: 11 },
  ];

  const grouped = objectsByReportingDistrict(payload.objects);
  const rows = board.names
    .map((name, index) => {
      const objects = grouped.get(name) || [];
      const withPhoto = objects.filter((object) => object.confirmedPhotos + object.pendingReviewPhotos > 0).length;
      return {
        district: name,
        objects: objects.length,
        plan: headquartersValues(board.counts[index])[9],
        fact: headquartersValues(board.counts[index])[10],
        percent: headquartersValues(board.counts[index])[11],
        withPhoto,
        coverage: objects.length ? Math.round((withPhoto / objects.length) * 100) : null,
        pending: objects.filter((object) => object.pendingReviewPhotos > 0).length,
        risks: risksByDistrict.get(name) || 0,
      };
    })
    .sort((left, right) => right.percent - left.percent || left.district.localeCompare(right.district, 'ru'));

  rows.forEach((row, index) => sheet.addRow({ index: index + 1, ...row }));

  const totalValues = headquartersValues(board.total);
  const totalRow = sheet.addRow({
    index: '',
    district: 'ИТОГО по САО',
    objects: payload.objects.length,
    plan: totalValues[9],
    fact: totalValues[10],
    percent: totalValues[11],
    withPhoto: payload.objects.filter((object) => object.confirmedPhotos + object.pendingReviewPhotos > 0).length,
    coverage: payload.objects.length
      ? Math.round((payload.objects.filter((object) => object.confirmedPhotos + object.pendingReviewPhotos > 0).length / payload.objects.length) * 100)
      : null,
    pending: payload.objects.filter((object) => object.pendingReviewPhotos > 0).length,
    risks: rows.reduce((sum, row) => sum + row.risks, 0),
  });
  totalRow.font = { bold: true };
  for (let column = 1; column <= 10; column += 1) totalRow.getCell(column).fill = TOTAL_FILL;

  styleHeaderRow(sheet, 10);
  shadeRows(sheet, sheet.rowCount - 1, 10);
  frameTable(sheet, sheet.rowCount, 10);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'J1' };
  const lastDistrict = sheet.rowCount - 1;
  sheet.addConditionalFormatting({ ref: `F2:F${lastDistrict}`, rules: [PERCENT_BAR('FF1C7A55')] });
  sheet.addConditionalFormatting({ ref: `H2:H${lastDistrict}`, rules: [PERCENT_BAR('FF7FB89F')] });
  sheet.addConditionalFormatting({
    ref: `J2:J${lastDistrict}`,
    rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [0], style: { fill: RISK_FILL, font: { color: { argb: 'FF9E2B25' }, bold: true } } }],
  });
  return sheet;
}

/**
 * Лист района: сначала объекты района, ниже — его фотографии с превью.
 * Лист самодостаточен, поэтому его можно отдать району целиком.
 * Имя листа приходит готовым: длинные названия обрезаны и разведены с уже
 * занятыми, иначе повтор имени обрывает выгрузку целиком.
 */
async function addDistrictSheet(workbook, { district, sheetName, objects, risksByObject }) {
  const sheet = workbook.addWorksheet(sheetName ?? districtSheetName(district));
  const marks = headquartersCountsFor(objects);
  const percent = headquartersOverallPercentFor(marks);
  const withPhoto = objects.filter((object) => object.confirmedPhotos + object.pendingReviewPhotos > 0).length;

  sheet.mergeCells('A1:L1');
  const title = sheet.getCell('A1');
  title.value = `${district} — объектов ${objects.length}, отметок ${marks.plan}, закрыто ${marks.fact} — ${percent} % (с фото ${withPhoto})`;
  title.font = SECTION_FONT;
  title.fill = SECTION_FILL;
  title.alignment = TO_LEFT;
  sheet.getRow(1).height = 22;

  const objectColumns = [
    { header: '№', key: 'index', width: 6 },
    { header: 'Тип', key: 'objectType', width: 14 },
    { header: 'Объект', key: 'label', width: 42 },
    { header: 'Балансодержатель', key: 'balanceHolder', width: 26 },
    { header: 'Ключ', key: 'objectKey', width: 38 },
    { header: 'Отметок', key: 'points', width: 11 },
    { header: 'Закрыто', key: 'covered', width: 11 },
    { header: '%', key: 'percent', width: 8 },
    { header: 'Подтверждено', key: 'confirmed', width: 13 },
    { header: 'На проверке', key: 'pending', width: 12 },
    { header: 'GPS‑риск', key: 'geoRisk', width: 10 },
    { header: 'Рисков', key: 'risks', width: 10 },
  ];
  objectColumns.forEach((column, index) => { sheet.getColumn(index + 1).width = column.width; });

  sheet.getRow(2).values = objectColumns.map((column) => column.header);
  styleHeaderRow(sheet, objectColumns.length, 2);

  let row = 3;
  objects.forEach((object, index) => {
    const plan = Math.max(0, Number(object.sourcePointCount) || 0);
    const covered = Math.min(Math.max(0, Number(object.coveredPoints) || 0), plan);
    const excelRow = sheet.getRow(row);
    excelRow.values = [
      index + 1,
      objectTypeLabel(object.objectType),
      object.label,
      object.balanceHolder || '—',
      object.objectKey,
      plan,
      covered,
      plan ? Math.round((covered / plan) * 100) : 0,
      object.confirmedPhotos,
      object.pendingReviewPhotos,
      object.geoRisk ? 'Да' : 'Нет',
      risksByObject.get(object.objectKey) || 0,
    ];
    for (let column = 1; column <= objectColumns.length; column += 1) {
      const cell = excelRow.getCell(column);
      cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
      cell.alignment = column === 3 || column === 4 || column === 5 ? TO_LEFT : CENTERED;
    }
    if (index % 2 === 1) for (let column = 1; column <= objectColumns.length; column += 1) excelRow.getCell(column).fill = ZEBRA_FILL;
    row += 1;
  });
  const objectLastRow = row - 1;
  if (objectLastRow >= 3) {
    sheet.addConditionalFormatting({ ref: `H3:H${objectLastRow}`, rules: [PERCENT_BAR('FF1C7A55')] });
  }

  // Фотографии района: тот же порядок колонок, что на общем листе «Фотографии».
  row += 1;
  sheet.mergeCells(row, 1, row, 10);
  const photoTitle = sheet.getCell(row, 1);
  photoTitle.value = `Фотографии района «${district}»`;
  photoTitle.font = SECTION_FONT;
  photoTitle.fill = SECTION_FILL;
  photoTitle.alignment = TO_LEFT;
  sheet.getRow(row).height = 22;
  row += 1;

  const photoColumns = [
    { header: '№', width: 6 }, { header: 'Тип', width: 14 }, { header: 'Объект', width: 38 },
    { header: 'Статус проверки', width: 20 }, { header: 'GPS', width: 18 }, { header: 'Дистанция, м', width: 14 },
    { header: 'Исполнитель', width: 24 }, { header: 'Комментарий', width: 42 }, { header: 'Имя файла', width: 30 },
    { header: 'Превью', width: 22 },
  ];
  sheet.getRow(row).values = photoColumns.map((column) => column.header);
  styleHeaderRow(sheet, photoColumns.length, row);
  row += 1;

  let photoNumber = 0;
  for (const object of objects) {
    for (const photo of object.photos || []) {
      photoNumber += 1;
      const excelRow = sheet.getRow(row);
      excelRow.values = [
        photoNumber, objectTypeLabel(object.objectType), object.label,
        photo.reviewStatus, photo.geoStatus, photo.distanceM ?? '—',
        photo.performer, photo.comment, photo.originalFilename,
      ];
      excelRow.height = 78;
      for (let column = 1; column <= 9; column += 1) {
        excelRow.getCell(column).border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
      }
      try {
        // Встраивается только превью: оригиналы делают книгу несоразмерно тяжёлой.
        const key = photo.thumbnailKey || photo.storageKey;
        const buffer = await readFile(`${mediaRoot()}/${key}`);
        const imageId = workbook.addImage({ buffer, extension: key.endsWith('.png') ? 'png' : key.endsWith('.webp') ? 'webp' : 'jpeg' });
        sheet.addImage(imageId, { tl: { col: 9, row: row - 1 }, ext: { width: 150, height: 90 } });
      } catch {
        // Метаданные остаются в строке, даже если файл недоступен.
      }
      row += 1;
    }
  }

  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  return sheet;
}

/** Отметки и процент района — тем же счётом, что на листе «На штаб». */
function headquartersCountsFor(objects) {
  let plan = 0;
  let fact = 0;
  for (const object of objects) {
    const objectPlan = Math.max(0, Number(object.sourcePointCount) || 0);
    plan += objectPlan;
    fact += Math.min(Math.max(0, Number(object.coveredPoints) || 0), objectPlan);
  }
  return { plan, fact };
}

function headquartersOverallPercentFor(marks) {
  return marks.plan ? Math.round((marks.fact / marks.plan) * 100) : 0;
}

/**
 * «Единая выгрузка по районам»: сводка по районам, эталонный лист «На штаб»,
 * топы по нарушениям и по отдельному листу на каждый район — объекты района и его
 * фотографии. Отдаётся району целиком либо используется для сверки районов между
 * собой: числа те же, что на остальных листах и в сводке для Telegram.
 */
export async function buildDistrictsExcel(rows) {
  const payload = reportPayload(rows);
  const board = headquartersBoard(payload);
  const risks = collectRisks(payload.objects);

  const risksByDistrict = new Map();
  const risksByObject = new Map();
  for (const risk of risks) {
    const district = reportingDistrict(risk);
    risksByDistrict.set(district, (risksByDistrict.get(district) || 0) + 1);
    if (risk.objectKey) risksByObject.set(risk.objectKey, (risksByObject.get(risk.objectKey) || 0) + 1);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SAO photo service';
  workbook.created = new Date();

  addDistrictSummarySheet(workbook, payload, board, risksByDistrict);
  addHeadquartersSheet(workbook, payload);
  addTopsSheet(workbook, risks);

  const grouped = objectsByReportingDistrict(payload.objects);
  for (const district of board.names) {
    await addDistrictSheet(workbook, {
      district,
      sheetName: uniqueSheetName(workbook, districtSheetName(district)),
      objects: grouped.get(district) || [],
      risksByObject,
    });
  }

  return workbook.xlsx.writeBuffer();
}

export function buildPdf(rows) {
  const payload = reportPayload(rows);
  const overall = payload.overall;
  const districts = payload.byDistrict;
  const dynamics = uploadDynamics(rows, { days: DYNAMICS_DAYS });
  const mix = completionMix(overall);
  // Топы по нарушениям — те же числа, что и на листе «Топы».
  const risks = collectRisks(payload.objects);
  const tops = riskTops(risks);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: 'Краткий отчёт фотофиксации САО' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Without a Cyrillic font the whole report is unreadable and copies as garbage.
    doc.registerFont(PDF_FONT_NAME, PDF_FONT_PATH);
    doc.font(PDF_FONT_NAME);

    const left = MARGIN;
    const width = doc.page.width - MARGIN * 2;
    let y = MARGIN;

    doc.fillColor(CHART_COLORS.ink).fontSize(18).text('Краткий отчёт фотофиксации САО', left, y);
    y = doc.y + 3;
    doc.fillColor(CHART_COLORS.muted).fontSize(8.5)
      .text(`Сформирован: ${new Date().toLocaleString('ru-RU')} (МСК)   ·   Версия набора объектов: ${payload.sourceVersions.join(', ') || 'не указана'}`, left, y);
    y = doc.y + 18;

    /* ------------------------------------------------------------ выполнение */
    doc.fillColor(CHART_COLORS.ink).fontSize(30).text(percentLabel(overall.completionPercent), left, y);
    const afterNumber = doc.y;
    const chipEnd = drawBandChip(doc, { x: left + 150, y: y + 8, band: overall.statusBand, label: statusBandLabel(overall.statusBand) });
    doc.fillColor(CHART_COLORS.muted).fontSize(9)
      .text(`выполнено ${overall.completedObjects} из ${overall.totalObjects} объектов`, chipEnd + 10, y + 14);
    y = Math.max(afterNumber, y + 44) + 10;

    drawGauge(doc, { x: left, y, width, height: 16, percent: overall.completionPercent, band: overall.statusBand });
    y += 30;

    doc.fillColor(CHART_COLORS.muted).fontSize(9)
      .text(`С фото: ${overall.objectsWithPhoto}   ·   Без фото: ${overall.objectsWithoutPhoto}   ·   На проверке: ${overall.pendingReviewObjects}   ·   Риск GPS: ${overall.geoRiskObjects}`, left, y);
    // Вторая строка — единица учёта: отметка, то есть конкретная точка на карте.
    doc.fillColor(CHART_COLORS.muted).fontSize(9)
      .text(`Отметки: ${overall.coveredPoints.toLocaleString('ru-RU')} из ${overall.totalPoints.toLocaleString('ru-RU')} отработано`, left, doc.y + 1);
    y = doc.y + 22;

    /* ------------------------------------------------------ состояние объектов */
    y = section(doc, y, 'Состояние объектов');
    y = drawStackedBar(doc, { x: left, y, width, segments: mix });

    /* ------------------------------------------------------------- по типам */
    y = section(doc, y + 6, 'Выполнение по типам объектов');
    for (const type of OBJECT_TYPES) {
      const summary = payload.byType[type];
      y = drawBarRow(doc, {
        x: left, y, labelWidth: 100, trackWidth: width - 200,
        label: objectTypeLabel(type),
        percent: summary.completionPercent,
        band: summary.statusBand,
        value: percentLabel(summary.completionPercent),
        note: `${summary.completedObjects} из ${summary.totalObjects} · ${statusBandLabel(summary.statusBand)}`,
      });
    }

    /* ------------------------------------------------------------- динамика */
    y = section(doc, y + 8, `Динамика загрузки, ${DYNAMICS_DAYS} дней`);
    const uploaded = dynamics.reduce((sum, point) => sum + point.uploaded, 0);
    y = drawColumns(doc, { x: left, y: y + 10, width, height: 78, points: dynamics });
    doc.fillColor(CHART_COLORS.muted).fontSize(8)
      .text(uploaded === 0
        ? 'За период фиксаций не было.'
        : `Загружено за период: ${uploaded}. Всего в службе: ${dynamics[dynamics.length - 1].cumulative}.`, left, y);
    y = doc.y + 18;

    /* ------------------------------------------------------------ по районам */
    if (districts.length > 1) {
      doc.addPage();
      y = MARGIN;
      y = section(doc, y, 'Выполнение по районам');
      for (const district of districts) {
        if (y > doc.page.height - 80) {
          doc.addPage();
          y = MARGIN;
        }
        y = drawBarRow(doc, {
          x: left, y, labelWidth: 130, trackWidth: width - 230,
          label: district.district || 'Без района',
          percent: district.completionPercent,
          band: district.statusBand,
          value: percentLabel(district.completionPercent),
          note: `${district.completedObjects} из ${district.totalObjects}`,
        });
      }
      y += 10;
      doc.fillColor(CHART_COLORS.muted).fontSize(8)
        .text('Районы отсортированы по выполнению. Объекты с балансодержателем «АвД САО», «ДЭУ» и объекты без района учтены в строке «АвД САО».', left, y, { width });
    }

    /* -------------------------------------------------------- топы по рискам */
    if (y > doc.page.height - 150) {
      doc.addPage();
      y = MARGIN;
    }
    y = section(doc, y + 8, 'Топ районов по рискам');
    if (!tops.total) {
      doc.fillColor(CHART_COLORS.muted).fontSize(9).text('Риски не выявлены.', left, y);
      y = doc.y + 12;
    } else {
      const worst = Math.max(1, ...tops.districts.map((entry) => entry.count));
      for (const entry of tops.districts) {
        if (y > doc.page.height - 60) {
          doc.addPage();
          y = MARGIN;
        }
        y = drawBarRow(doc, {
          x: left, y, labelWidth: 130, trackWidth: width - 230,
          label: entry.district,
          percent: (entry.count / worst) * 100,
          band: 'low',
          value: String(entry.count),
          note: entry.count === 1 ? 'нарушение' : 'нарушений',
        });
      }
      doc.fillColor(CHART_COLORS.muted).fontSize(8)
        .text(`Всего нарушений: ${tops.total}. Полосы показаны относительно самого проблемного района.`, left, y + 4, { width });
      y = doc.y + 16;
    }

    /* --------------------------------------------------- топы исполнителей */
    if (y > doc.page.height - 130) {
      doc.addPage();
      y = MARGIN;
    }
    y = section(doc, y + 8, 'Топ исполнителей по районам');
    if (!tops.total) {
      doc.fillColor(CHART_COLORS.muted).fontSize(9).text('Риски не выявлены.', left, y);
      y = doc.y + 12;
    } else {
      for (const entry of tops.districts) {
        if (y > doc.page.height - 90) {
          doc.addPage();
          y = MARGIN;
        }
        doc.fillColor(CHART_COLORS.ink).fontSize(10).text(`${entry.district} · ${entry.count} нарушений`, left, y);
        y = doc.y + 4;
        for (const performer of entry.performers) {
          if (y > doc.page.height - 50) {
            doc.addPage();
            y = MARGIN;
          }
          y = drawBarRow(doc, {
            x: left + 12, y, labelWidth: 160, trackWidth: width - 272,
            label: performer.performer,
            percent: (performer.count / entry.count) * 100,
            band: 'low',
            value: String(performer.count),
          });
        }
        y += 8;
      }
      doc.fillColor(CHART_COLORS.muted).fontSize(8)
        .text(`На каждый район показано до ${tops.performerLimit} исполнителей с наибольшим числом нарушений.`, left, y, { width });
    }

    doc.end();
  });
}
