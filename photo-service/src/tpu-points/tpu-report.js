// Сводки по оцифровке ТПУ и по парковкам для префектуры (Excel по кнопкам на карте ТПУ).
// Каждая сводка — отдельный файл только по своему виду объектов; отчёты ПП/ООТ/подъездов не затрагиваются.
import { readFileSync } from 'node:fs';
import { requiredPhotos, slotState } from './object-slots.js';

export const TPU_OBJECTS = JSON.parse(readFileSync(new URL('./tpu-objects.json', import.meta.url), 'utf8'));
// Карманы и парковки из выгрузки АСУ ОДХ несут свой тип в каталоге (поле type).
const KIND = { tpu: 'ТПУ', parking: 'Парковка' };
/** Виды сводок: что выгружается и как называется. */
export const REPORT_KINDS = {
  tpu: { title: 'ТПУ', file: 'Svodka_TPU_SAO' },
  parking: { title: 'автомобильных парковок', file: 'Svodka_Parkovki_SAO' },
};
const DAY = 24 * 60 * 60 * 1000;
const MOSCOW = 3 * 60 * 60 * 1000;

const moscowDate = (value) => new Date(new Date(value).getTime() + MOSCOW).toISOString().slice(0, 10);
const percent = (part, whole) => (whole ? part / whole : 0);
// База отдаёт даты объектами Date: сравниваем их только в виде ISO-строк.
const iso = (value) => (value ? new Date(value).toISOString() : null);

/** Статус объекта по его точкам: съёмка засчитывается только по текущему ракурсу точки. */
export function objectStatus(points) {
  if (!points.length) return 'Нет точек';
  const shot = points.filter((p) => Number(p.photo_count) > 0).length;
  if (!shot) return 'Не начато';
  return shot === points.length ? 'Готово' : 'В работе';
}

/** Чистый расчёт чисел сводки: Excel только раскладывает их по листам. */
export function summarizeTpu({ objects: all = TPU_OBJECTS, kind = null, points, slots = [], daily = [], generatedAt = new Date(), days = 14 }) {
  const objects = kind ? all.filter((o) => o.kind === kind) : all;
  const byObject = new Map(objects.map((o) => [o.id, []]));
  for (const point of points) if (byObject.has(point.object_key)) byObject.get(point.object_key).push(point);
  const slotsByObject = new Map();
  for (const row of slots) { if (!slotsByObject.has(row.object_key)) slotsByObject.set(row.object_key, []); slotsByObject.get(row.object_key).push(row); }
  const objectRows = objects.map((o) => {
    const own = byObject.get(o.id);
    const shot = own.filter((p) => Number(p.photo_count) > 0);
    const last = shot.map((p) => iso(p.last_photo_at)).filter(Boolean).sort().at(-1) || null;
    // Фото по слотам задания и их проверка префектурой.
    const check = slotState(requiredPhotos(o), slotsByObject.get(o.id) || []);
    const comments = check.slots.filter((s) => s.rejected).map((s) => `Слот ${s.slot}: ${s.rejected.review_comment}`).join('\n');
    return { ...o, points: own.length, shot: shot.length, status: objectStatus(own), lastPhotoAt: last,
      slotsRequired: check.required, slotsFilled: check.filled, slotsAccepted: check.accepted,
      pendingSlots: check.slots.filter((s) => s.photo?.status === 'pending').length,
      reworkSlots: check.slots.filter((s) => s.rejected).length,
      slotList: check.slots, slotStatus: check.label, slotComments: comments };
  });
  const groups = [...new Set(objects.map((o) => o.group))].sort((a, b) => a.localeCompare(b, 'ru'));
  const tally = (rows) => ({
    tpu: rows.filter((r) => r.kind === 'tpu').length,
    parking: rows.filter((r) => r.kind === 'parking').length,
    withoutPoints: rows.filter((r) => r.points === 0).length,
    points: rows.reduce((s, r) => s + r.points, 0),
    shot: rows.reduce((s, r) => s + r.shot, 0),
    done: rows.filter((r) => r.status === 'Готово').length,
    lastPhotoAt: rows.map((r) => r.lastPhotoAt).filter(Boolean).sort().at(-1) || null,
    slotsRequired: rows.reduce((s, r) => s + r.slotsRequired, 0),
    slotsAccepted: rows.reduce((s, r) => s + r.slotsAccepted, 0),
  });
  const groupRows = groups.map((group) => ({ group, ...tally(objectRows.filter((r) => r.group === group)) }));
  const total = { group: 'Итого', ...tally(objectRows) };
  const known = new Set(objects.map((o) => o.id));
  const pointRows = points.filter((p) => known.has(p.object_key)).map((p) => {
    const object = objects.find((o) => o.id === p.object_key);
    return { ...p, object };
  }).sort((a, b) => a.object.group.localeCompare(b.object.group, 'ru') || a.object.label.localeCompare(b.object.label, 'ru') || String(iso(a.created_at)).localeCompare(String(iso(b.created_at))));
  const end = Date.parse(moscowDate(generatedAt));
  const counts = new Map(daily.map((d) => [typeof d.day === 'string' ? d.day.slice(0, 10) : moscowDate(d.day), d]));
  const dynamics = Array.from({ length: days }, (_, i) => {
    const date = new Date(end - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    const row = counts.get(date);
    return { date, photos: Number(row?.photos || 0), points: Number(row?.points || 0) };
  });
  return { kind, generatedAt, objectRows, groupRows, total, pointRows, dynamics };
}

const HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123A32' } };
const SLOT_FILL = { 'Закрыта': 'FFD8F0DE', 'На проверке': 'FFDCE8FB', 'В работе': 'FFFFF1C2', 'На доработке': 'FFF9DCD6', 'Нет фото': 'FFE9ECEF' };
const STATUS_FILL = { 'Готово': 'FFD8F0DE', 'В работе': 'FFFFF1C2', 'Не начато': 'FFF9DCD6', 'Нет точек': 'FFE9ECEF' };

function headerRow(sheet, titles, widths) {
  sheet.columns = titles.map((header, i) => ({ header, width: widths[i] }));
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER;
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 32;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

const dateText = (value) => (value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '');

const PARKING_TYPE_LABELS = { 'Парковка': 'Автомобильные парковки', 'Парковочный карман': 'Парковочные карманы' };
const YELLOW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const THIN = { style: 'thin' };
const CENTER = { horizontal: 'center', vertical: 'center' };

/** Эталон префектуры: все ячейки данных по центру и в тонкой рамке. */
function frameRows(sheet, firstRow, lastRow, columns) {
  for (let i = firstRow; i <= lastRow; i++) {
    const row = sheet.getRow(i);
    for (let j = 1; j <= columns; j++) {
      const cell = row.getCell(j);
      cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
      cell.alignment = CENTER;
    }
  }
}

function styleGreenHeader(sheet, rowIndex, columns) {
  const row = sheet.getRow(rowIndex);
  row.height = 32.1;
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { ...CENTER, wrapText: true };
  for (let j = 1; j <= columns; j++) row.getCell(j).fill = HEADER;
}

/** Проверка слотов для строки сводки: статусы объектов, доля принятых фото, последнее фото. */
const parkingTally = (rows) => ({
  count: rows.length,
  closed: rows.filter((r) => r.slotStatus === 'Закрыта').length,
  empty: rows.filter((r) => r.slotStatus === 'Нет фото').length,
  review: rows.filter((r) => r.slotStatus === 'На проверке').length,
  rework: rows.filter((r) => r.slotStatus === 'На доработке').length,
  accepted: rows.reduce((sum, r) => sum + r.slotsAccepted, 0),
  required: rows.reduce((sum, r) => sum + r.slotsRequired, 0),
  lastPhotoAt: rows.map((r) => r.lastPhotoAt).filter(Boolean).sort().at(-1) || null,
});

/** Книга по парковкам — точный формат эталона префектуры (ЭТАЛОН ПАРКОВКИ СВОД.xlsx). */
async function buildParkingReport(summary, { mapUrl = 'https://hainox.github.io/karta-sao/object-maps/tpu-parking.html' } = {}) {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  book.created = summary.generatedAt;

  const headers = ['Район / организация', 'Всего Объектов', 'Объектов закрыто', 'Объектов без фото', 'Обьектов на проверке', 'Обьектов на доработке ', '% принято', 'Последнее фото'];
  const widths = [28, 12, undefined, undefined, 12.3, undefined, 10.6, 15.9];
  const overview = book.addWorksheet('Свод по районам');
  overview.columns = headers.map((header, i) => ({ header, width: widths[i] }));
  // Титул и пояснение — жёлтые строки в жирной рамке над шапкой (строки 1–2), шапка — строка 4.
  overview.spliceRows(1, 0, [`Свод по фото парковок на ${dateText(summary.generatedAt)}`], ['Слоты по заданию: принято — фото проверено префектурой; на доработке — фото отклонено, слот ждёт нового фото.'], []);
  overview.mergeCells(1, 1, 1, 8);
  overview.mergeCells(2, 1, 2, 8);
  const titleRow = overview.getRow(1);
  titleRow.font = { bold: true, size: 14 };
  titleRow.fill = YELLOW_FILL;
  titleRow.border = { top: { style: 'medium' } };
  titleRow.height = 18.75;
  const legendRow = overview.getRow(2);
  legendRow.font = { size: 11 };
  legendRow.fill = YELLOW_FILL;
  legendRow.border = { bottom: { style: 'medium' } };
  legendRow.height = 15.75;

  const writeRow = (label, tally, bold = false) => {
    const row = overview.addRow([label, tally.count, tally.closed, tally.empty, tally.review, tally.rework, percent(tally.accepted, tally.required), dateText(tally.lastPhotoAt)]);
    row.getCell(7).numFmt = '0%';
    if (bold) row.font = { bold: true };
    return row;
  };
  for (const group of summary.groupRows) writeRow(group.group, parkingTally(summary.objectRows.filter((r) => r.group === group.group)));
  writeRow('Итого по САО', parkingTally(summary.objectRows), true);
  // Вторая таблица: разбивка по виду объекта (парковки и карманы отдельно).
  overview.addRow([]);
  const breakdownHeaderRow = overview.addRow(['Вид объекта', ...headers.slice(1)]);
  breakdownHeaderRow.height = 32.1;
  styleGreenHeader(overview, breakdownHeaderRow.number, 8);
  for (const [type, label] of Object.entries(PARKING_TYPE_LABELS)) writeRow(label, parkingTally(summary.objectRows.filter((r) => (r.type || KIND[r.kind] || r.kind) === type)));
  styleGreenHeader(overview, 4, 8);
  frameRows(overview, 4, overview.rowCount, 8);
  overview.views = [{ state: 'frozen', ySplit: 4 }];

  const objects = book.addWorksheet('Объекты');
  headerRow(objects, ['Вид', 'Название', 'ID', 'Ответственный', 'Фото требуется', 'Загружено', 'Принято', 'На проверке', 'На доработке', 'Статус', 'Последнее фото', 'На карте'], [10, 50, 14, 22, 11, 11, 10, 11, 12, 14, 17, 12]);
  objects.autoFilter = { from: 'A1', to: 'L1' };
  for (const r of summary.objectRows) {
    const row = objects.addRow([r.type || KIND[r.kind] || r.kind, r.label, r.sourceNumber, r.group, r.slotsRequired, r.slotsFilled, r.slotsAccepted, r.pendingSlots, r.reworkSlots, r.slotStatus, dateText(r.lastPhotoAt), { text: 'Открыть', hyperlink: `${mapUrl}?object=${encodeURIComponent(r.id)}` }]);
    row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SLOT_FILL[r.slotStatus] || 'FFE9ECEF' } };
    row.getCell(12).font = { color: { argb: 'FF0C5AA6' } };
  }
  frameRows(objects, 2, objects.rowCount, 12);

  const rework = book.addWorksheet('На доработке');
  headerRow(rework, ['Ответственный', 'Объект', 'Слот', 'Что исправить', 'Отклонено', 'На карте'], [25, 50, 8, 60, 17, 12]);
  for (const r of summary.objectRows) {
    for (const slot of r.slotList) {
      if (!slot.rejected) continue;
      const row = rework.addRow([r.group, r.label, slot.slot, slot.rejected.review_comment, dateText(slot.rejected.reviewed_at), { text: 'Открыть', hyperlink: `${mapUrl}?object=${encodeURIComponent(r.id)}` }]);
      row.getCell(6).font = { color: { argb: 'FF0C5AA6' } };
    }
  }
  if (rework.rowCount < 2) rework.addRow(['Слотов на доработке нет.']);
  frameRows(rework, 2, rework.rowCount, 6);

  return Buffer.from(await book.xlsx.writeBuffer());
}

/** Книга Excel со сводкой по ТПУ и парковкам. */
export async function buildTpuReport(summary, options = {}) {
  // Парковки — отдельный формат по эталону префектуры; ТПУ и общая книга остаются прежними.
  if (summary.kind === 'parking') return buildParkingReport(summary, options);
  const { mapUrl = 'https://hainox.github.io/karta-sao/object-maps/tpu-parking.html' } = options;
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  book.created = summary.generatedAt;

  const overview = book.addWorksheet('Сводка');
  // Сводка одного вида: один столбец «Объектов»; общая — отдельные столбцы ТПУ и парковок.
  const counts = summary.kind ? [['Объектов', 10, (r) => r[summary.kind]]] : [['ТПУ', 8, (r) => r.tpu], ['Парковки', 10, (r) => r.parking]];
  headerRow(overview, ['Район / организация', ...counts.map((c) => c[0]), 'Объектов без точек', 'Точек съёмки', 'Отснято точек', '% отснято', 'Объектов готово', 'Последнее фото'], [26, ...counts.map((c) => c[1]), 12, 11, 11, 10, 11, 18]);
  const title = summary.kind ? REPORT_KINDS[summary.kind].title : 'ТПУ и парковок';
  overview.spliceRows(1, 0, [`Сводка оцифровки ${title} САО на ${dateText(summary.generatedAt)}`], []);
  overview.getRow(1).font = { bold: true, size: 14 };
  overview.views = [{ state: 'frozen', ySplit: 3 }];
  const percentColumn = counts.length + 5;
  for (const r of [...summary.groupRows, summary.total]) {
    const row = overview.addRow([r.group, ...counts.map((c) => c[2](r)), r.withoutPoints, r.points, r.shot, percent(r.shot, r.points), r.done, dateText(r.lastPhotoAt)]);
    row.getCell(percentColumn).numFmt = '0%';
    if (r.group === 'Итого') row.font = { bold: true };
  }
  const letter = String.fromCharCode(64 + percentColumn);
  overview.addConditionalFormatting({ ref: `${letter}4:${letter}${overview.rowCount}`, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FF0C7A5A' } }] });

  const objects = book.addWorksheet('Объекты');
  headerRow(objects, ['Тип', 'Название', 'ID', 'Ответственный', 'Район по контуру', 'Балансодержатель', 'Точек', 'Отснято', 'Статус', 'Последнее фото', 'На карте', 'Фото требуется', 'Фото принято', 'Проверка фото', 'Что исправить'], [10, 48, 13, 22, 20, 26, 8, 9, 12, 18, 12, 10, 10, 14, 40]);
  for (const r of summary.objectRows) {
    const row = objects.addRow([r.type || KIND[r.kind] || r.kind, r.label, r.sourceNumber, r.group, r.district, r.holder, r.points, r.shot, r.status, dateText(r.lastPhotoAt), { text: 'Открыть', hyperlink: `${mapUrl}?object=${encodeURIComponent(r.id)}` }, r.slotsRequired, r.slotsAccepted, r.slotStatus, r.slotComments]);
    row.getCell(14).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SLOT_FILL[r.slotStatus] || 'FFE9ECEF' } };
    row.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[r.status] } };
    row.getCell(11).font = { color: { argb: 'FF0C5AA6' }, underline: true };
  }
  objects.autoFilter = { from: 'A1', to: 'O1' };

  const points = book.addWorksheet('Точки');
  headerRow(points, ['Ответственный', 'Тип', 'Объект', 'Точка', 'Задание', 'Широта', 'Долгота', 'Направление, °', 'Фото текущего ракурса', 'Последнее фото', 'Назначена'], [22, 10, 44, 14, 36, 11, 11, 12, 12, 18, 18]);
  for (const p of summary.pointRows) {
    points.addRow([p.district, p.object.type || KIND[p.object.kind] || p.object.kind, p.object.label, p.label, p.note || '', Number(p.latitude), Number(p.longitude), p.heading == null ? '' : Math.round(Number(p.heading)), Number(p.photo_count) > 0 ? 'Да' : 'Нет', dateText(p.last_photo_at), dateText(p.created_at)]);
  }
  points.autoFilter = { from: 'A1', to: 'K1' };

  const dynamics = book.addWorksheet('Динамика');
  headerRow(dynamics, ['Дата', 'Загружено фото', 'Точек с новыми фото'], [14, 16, 20]);
  for (const d of summary.dynamics) dynamics.addRow([d.date.split('-').reverse().join('.'), d.photos, d.points]);

  return Buffer.from(await book.xlsx.writeBuffer());
}
