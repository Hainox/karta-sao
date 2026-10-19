// Свод для префектуры по фото в слотах карты ТПУ и парковок (Excel по отдельной кнопке).
// Считает только слоты по заданию: сколько фото требуется, загружено, принято и на доработке —
// по районам и АвД САО, по видам объектов и по каждому объекту.
import ExcelJS from 'exceljs';
import { requiredPhotos, slotState, SLOT_OBJECTS, SLOT_STATUS_LABELS } from './object-slots.js';

const KIND_LABELS = { tpu: 'ТПУ', parking: 'Автомобильные парковки', pocket: 'Парковочные карманы' };
const kindOf = (object) => (object.kind === 'tpu' ? 'tpu' : object.type === 'Парковочный карман' ? 'pocket' : 'parking');
const percent = (part, whole) => (whole ? part / whole : 0);
const latest = (values) => values.filter(Boolean).map((v) => new Date(v).toISOString()).sort().at(-1) || null;

/** Чистый расчёт свода: Excel только раскладывает числа по листам. */
export function summarizeSlots({ rows, objects = SLOT_OBJECTS, generatedAt = new Date() }) {
  const byObject = new Map();
  for (const row of rows) {
    if (!objects.has(row.object_key)) continue;
    if (!byObject.has(row.object_key)) byObject.set(row.object_key, []);
    byObject.get(row.object_key).push(row);
  }
  const objectRows = [];
  const rework = [];
  for (const [id, object] of objects) {
    const own = byObject.get(id) || [];
    const state = slotState(requiredPhotos(object), own);
    const pending = state.slots.filter((s) => s.photo?.status === 'pending').length;
    const reworkSlots = state.slots.filter((s) => s.rejected);
    for (const slot of reworkSlots) rework.push({ object, id, slot: slot.slot, comment: slot.rejected.review_comment, rejectedAt: slot.rejected.reviewed_at });
    objectRows.push({
      id, object, kind: kindOf(object), group: object.group,
      required: state.required, filled: state.filled, accepted: state.accepted, pending, rework: reworkSlots.length,
      status: state.status, statusLabel: SLOT_STATUS_LABELS[state.status],
      lastPhotoAt: latest(own.map((r) => r.uploaded_at)),
    });
  }
  const tally = (list, label) => ({
    label,
    objects: list.length,
    required: list.reduce((s, r) => s + r.required, 0),
    filled: list.reduce((s, r) => s + r.filled, 0),
    accepted: list.reduce((s, r) => s + r.accepted, 0),
    pending: list.reduce((s, r) => s + r.pending, 0),
    rework: list.reduce((s, r) => s + r.rework, 0),
    closed: list.filter((r) => r.status === 'closed').length,
    untouched: list.filter((r) => r.status === 'empty').length,
    lastPhotoAt: latest(list.map((r) => r.lastPhotoAt)),
  });
  const groups = [...new Set(objectRows.map((r) => r.group))].sort((a, b) => a.localeCompare(b, 'ru'));
  const groupRows = groups.map((g) => tally(objectRows.filter((r) => r.group === g), g));
  const kindRows = Object.entries(KIND_LABELS).map(([kind, label]) => tally(objectRows.filter((r) => r.kind === kind), label));
  rework.sort((a, b) => a.object.group.localeCompare(b.object.group, 'ru') || a.object.label.localeCompare(b.object.label, 'ru') || a.slot - b.slot);
  return { generatedAt, groupRows, kindRows, total: tally(objectRows, 'Итого по САО'), objectRows, rework };
}

// Оформление повторяет эталон префектуры: жёлтая шапка в рамке, все ячейки таблиц по центру и в тонкой рамке.
const HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123A32' } };
const TITLE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const STATUS_FILL = { closed: 'FFD8F0DE', review: 'FFDCE8FB', progress: 'FFFFF1C2', rework: 'FFF9DCD6', empty: 'FFE9ECEF' };
const THIN = { style: 'thin' };
const GRID = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const CENTER = { horizontal: 'center', vertical: 'middle' };
const LINK = { name: 'Calibri', size: 11, color: { argb: 'FF0C5AA6' } };
const dateText = (value) => (value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '');

function gridRow(row, columns, { bold = false, wrap = false } = {}) {
  for (let column = 1; column <= columns; column += 1) {
    const cell = row.getCell(column);
    cell.border = GRID;
    cell.alignment = wrap ? { ...CENTER, wrapText: true } : CENTER;
    cell.font = { name: 'Calibri', size: 11, bold };
  }
}

function header(sheet, rowNumber, titles) {
  const row = sheet.getRow(rowNumber);
  row.values = titles;
  gridRow(row, titles.length, { wrap: true });
  for (let column = 1; column <= titles.length; column += 1) {
    row.getCell(column).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    row.getCell(column).fill = HEADER;
  }
  row.height = 32.1;
}

/** Две объединённые жёлтые строки (заголовок и пояснение) в общей жирной рамке. */
function titleBlock(sheet, columns, title, note) {
  sheet.getCell('A1').value = title;
  sheet.getCell('A2').value = note;
  for (const rowNumber of [1, 2]) {
    for (let column = 1; column <= columns; column += 1) {
      const cell = sheet.getRow(rowNumber).getCell(column);
      cell.fill = TITLE;
      cell.font = { name: 'Calibri', size: rowNumber === 1 ? 14 : 11, bold: rowNumber === 1 };
      cell.alignment = { horizontal: 'center' };
      cell.border = {
        top: rowNumber === 1 ? { style: 'medium' } : undefined,
        bottom: rowNumber === 2 ? { style: 'medium' } : undefined,
        left: column === 1 ? { style: 'medium' } : undefined,
        right: column === columns ? { style: 'medium' } : undefined,
      };
    }
  }
  // Объединяем после оформления и без переноса стиля: иначе рамка крайних ячеек потеряется.
  const last = String.fromCharCode(64 + columns);
  sheet.mergeCellsWithoutStyle(`A1:${last}1`);
  sheet.mergeCellsWithoutStyle(`A2:${last}2`);
  sheet.getRow(1).height = 18.75;
}

const SUMMARY_TITLES = ['Объектов', 'Фото требуется', 'Фото загружено', 'Принято', 'На проверке', 'Слотов на доработке', 'Объектов закрыто', 'Объектов без фото', '% принято', 'Последнее фото'];
const summaryValues = (r) => [r.objects, r.required, r.filled, r.accepted, r.pending, r.rework, r.closed, r.untouched, percent(r.accepted, r.required), dateText(r.lastPhotoAt)];

export async function buildSlotReport(summary, { mapUrl = 'https://hainox.github.io/karta-sao/object-maps/tpu-parking.html' } = {}) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  const day = dateText(summary.generatedAt);
  const columns = SUMMARY_TITLES.length + 1;

  const overview = book.addWorksheet('Свод по районам');
  overview.columns = [{ width: 28 }, ...SUMMARY_TITLES.map((t, i) => ({ width: i === SUMMARY_TITLES.length - 1 ? 17 : 12 }))];
  titleBlock(overview, columns, `Свод по фото ТПУ и парковок на ${day}`,
    'Слоты по заданию: принято — фото проверено префектурой; на доработке — фото отклонено, слот ждёт нового фото.');
  header(overview, 4, ['Район / организация', ...SUMMARY_TITLES]);
  let rowNumber = 5;
  const writeRows = (list, bold) => {
    for (const r of list) {
      const row = overview.getRow(rowNumber++);
      row.values = [r.label, ...summaryValues(r)];
      gridRow(row, columns, { bold });
      row.getCell(10).numFmt = '0%';
    }
  };
  writeRows(summary.groupRows, false);
  writeRows([summary.total], true);
  overview.addConditionalFormatting({ ref: `J5:J${rowNumber - 1}`, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FF0C7A5A' } }] });
  rowNumber += 1;
  header(overview, rowNumber++, ['Вид объекта', ...SUMMARY_TITLES]);
  writeRows(summary.kindRows, false);
  overview.views = [{ state: 'frozen', ySplit: 4 }];

  const objects = book.addWorksheet('Объекты');
  objects.columns = [10, 50, 14, 22, 11, 11, 10, 11, 12, 14, 17, 12].map((width) => ({ width }));
  header(objects, 1, ['Вид', 'Название', 'ID', 'Ответственный', 'Фото требуется', 'Загружено', 'Принято', 'На проверке', 'На доработке', 'Статус', 'Последнее фото', 'На карте']);
  for (const r of summary.objectRows) {
    const row = objects.addRow([r.object.type || (r.kind === 'tpu' ? 'ТПУ' : 'Парковка'), r.object.label, r.object.sourceNumber, r.group, r.required, r.filled, r.accepted, r.pending, r.rework, r.statusLabel, dateText(r.lastPhotoAt), { text: 'Открыть', hyperlink: `${mapUrl}?object=${encodeURIComponent(r.id)}` }]);
    gridRow(row, 12);
    row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[r.status] } };
    row.getCell(12).font = LINK;
  }
  objects.views = [{ state: 'frozen', ySplit: 1 }];
  objects.autoFilter = { from: 'A1', to: 'L1' };

  const rework = book.addWorksheet('На доработке');
  rework.columns = [25, 50, 8, 60, 17, 12].map((width) => ({ width }));
  header(rework, 1, ['Ответственный', 'Объект', 'Слот', 'Что исправить', 'Отклонено', 'На карте']);
  for (const r of summary.rework) {
    const row = rework.addRow([r.object.group, r.object.label, r.slot, r.comment, dateText(r.rejectedAt), { text: 'Открыть', hyperlink: `${mapUrl}?object=${encodeURIComponent(r.id)}` }]);
    gridRow(row, 6, { wrap: true });
    row.getCell(6).font = LINK;
  }
  rework.views = [{ state: 'frozen', ySplit: 1 }];
  if (summary.rework.length) rework.autoFilter = { from: 'A1', to: 'F1' };
  else gridRow(rework.addRow(['Слотов на доработке нет.']), 6);

  return Buffer.from(await book.xlsx.writeBuffer());
}
