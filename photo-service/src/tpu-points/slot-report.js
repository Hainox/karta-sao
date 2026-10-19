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

const HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123A32' } };
const STATUS_FILL = { closed: 'FFD8F0DE', review: 'FFDCE8FB', progress: 'FFFFF1C2', rework: 'FFF9DCD6', empty: 'FFE9ECEF' };
const dateText = (value) => (value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '');

function header(sheet, rowNumber, titles) {
  const row = sheet.getRow(rowNumber);
  row.values = titles;
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER;
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 32;
}

const SUMMARY_TITLES = ['Объектов', 'Фото требуется', 'Фото загружено', 'Принято', 'На проверке', 'Слотов на доработке', 'Объектов закрыто', 'Объектов без фото', '% принято', 'Последнее фото'];
const summaryValues = (r) => [r.objects, r.required, r.filled, r.accepted, r.pending, r.rework, r.closed, r.untouched, percent(r.accepted, r.required), dateText(r.lastPhotoAt)];

export async function buildSlotReport(summary, { mapUrl = 'https://hainox.github.io/karta-sao/object-maps/tpu-parking.html' } = {}) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  const day = dateText(summary.generatedAt);

  const overview = book.addWorksheet('Свод по районам');
  overview.columns = [{ width: 28 }, ...SUMMARY_TITLES.map((t, i) => ({ width: i === SUMMARY_TITLES.length - 1 ? 17 : 12 }))];
  overview.getCell('A1').value = `Свод по фото ТПУ и парковок на ${day}`;
  overview.getCell('A1').font = { bold: true, size: 14 };
  overview.getCell('A2').value = 'Слоты по заданию: принято — фото проверено префектурой; на доработке — фото отклонено, слот ждёт нового фото.';
  header(overview, 4, ['Район / организация', ...SUMMARY_TITLES]);
  let rowNumber = 5;
  const writeRows = (list, bold) => {
    for (const r of list) {
      const row = overview.getRow(rowNumber++);
      row.values = [r.label, ...summaryValues(r)];
      row.getCell(10).numFmt = '0%';
      if (bold) row.font = { bold: true };
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
    row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[r.status] } };
    row.getCell(12).font = { color: { argb: 'FF0C5AA6' }, underline: true };
  }
  objects.views = [{ state: 'frozen', ySplit: 1 }];
  objects.autoFilter = { from: 'A1', to: 'L1' };

  const rework = book.addWorksheet('На доработке');
  rework.columns = [22, 50, 8, 60, 17, 12].map((width) => ({ width }));
  header(rework, 1, ['Ответственный', 'Объект', 'Слот', 'Что исправить', 'Отклонено', 'На карте']);
  for (const r of summary.rework) {
    const row = rework.addRow([r.object.group, r.object.label, r.slot, r.comment, dateText(r.rejectedAt), { text: 'Открыть', hyperlink: `${mapUrl}?object=${encodeURIComponent(r.id)}` }]);
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(6).font = { color: { argb: 'FF0C5AA6' }, underline: true };
  }
  rework.views = [{ state: 'frozen', ySplit: 1 }];
  if (summary.rework.length) rework.autoFilter = { from: 'A1', to: 'F1' };
  else rework.addRow(['Слотов на доработке нет.']);

  return Buffer.from(await book.xlsx.writeBuffer());
}
