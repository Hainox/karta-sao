// Свод Excel по фото остановок, ПП и подъездов — для кабинета приёмки фотофиксации.
//
// Формат повторяет эталон сводки по парковкам: «Свод по районам» с жёлтым
// титулом и тёмно-зелёными шапками, разбивкой по видам объектов, лист
// «Объекты» и отдельный лист «На доработке» с причиной возврата.
// Единица учёта — точка съёмки, а не кадр: у ПП два кадра, но одно задание.
import ExcelJS from 'exceljs';
import { PHOTO_NORM_SINCE, PHOTO_REQUIREMENTS } from './completion.js';
import { AUTODOR_HOLDER, reportingDistrict } from './scope.js';

export const REVIEW_TYPES = Object.freeze(['stop', 'pp', 'entrance']);
export const REVIEW_TYPE_LABELS = Object.freeze({
  stop: 'Остановки',
  pp: 'ПП',
  entrance: 'Подъезды (входные группы)',
});
const TYPE_TITLES = Object.freeze({
  stop: 'остановок',
  pp: 'ПП',
  entrance: 'подъездов (входных групп)',
});
const ALL_TITLE = 'остановок, ПП и подъездов (входных групп)';
const STATUS_LABELS = Object.freeze({
  empty: 'Нет фото',
  progress: 'В работе',
  review: 'На проверке',
  rework: 'На доработке',
  closed: 'Закрыт',
});
const TYPE_ORDER = new Map(REVIEW_TYPES.map((type, index) => [type, index]));
const NORM_SINCE = Date.parse(PHOTO_NORM_SINCE);

const timeOf = (value) => (value ? new Date(value).getTime() : 0);
// База отдаёт даты объектами Date, поэтому всё сравниваем через ISO.
const iso = (value) => (value ? new Date(value).toISOString() : null);
const latest = (values) => values.filter(Boolean).map(iso).sort().at(-1) || null;
const percent = (part, whole) => (whole ? part / whole : 0);
const dateText = (value) => (value
  ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })
  : '');

const photoOrder = (left, right) => timeOf(left.uploadedAt) - timeOf(right.uploadedAt)
  || String(left.id).localeCompare(String(right.id));

/** Снимки без отозванных: отозванный кадр не участвует ни в статусе, ни в счёте. */
const activePhotos = (row) => (Array.isArray(row.photos) ? row.photos : [])
  .filter((photo) => photo.reviewStatus && photo.reviewStatus !== 'withdrawn')
  .sort(photoOrder);

/**
 * Состояние точек объекта. У каждой точки действует последний кадр: отклонённый
 * отправляет точку на доработку, ожидающий — на проверку, подтверждённый
 * закрывает её, когда набрана норма вида. Кадры, снятые до PHOTO_NORM_SINCE,
 * засчитываются по прежней норме одного кадра — так же, как в сводке сервера.
 */
export function reviewPointStates(row) {
  const photos = activePhotos(row);
  const byPoint = new Map();
  for (const photo of photos) {
    const key = photo.sourceId ?? null;
    if (!byPoint.has(key)) byPoint.set(key, []);
    byPoint.get(key).push(photo);
  }
  const sourceIds = Array.isArray(row.source_ids) ? row.source_ids : [];
  // Объект без привязки к точкам источника всё равно должен получить статус:
  // считаем его одной точкой, иначе он навсегда останется «без фото».
  const keys = sourceIds.length ? sourceIds : [null];
  const norm = PHOTO_REQUIREMENTS[row.object_type] || 1;
  const points = keys.map((sourceId, index) => {
    const own = byPoint.get(sourceId) || [];
    const last = own.at(-1) || null;
    const modern = own.some((photo) => timeOf(photo.uploadedAt) >= NORM_SINCE);
    const required = modern ? norm : 1;
    const accepted = own.filter((photo) => photo.reviewStatus === 'confirmed').length;
    let status = 'empty';
    let rejected = null;
    if (last) {
      if (last.reviewStatus === 'rejected') {
        status = 'rework';
        rejected = last;
      } else if (last.reviewStatus === 'pending_review') {
        status = 'review';
      } else {
        status = accepted >= required ? 'closed' : 'progress';
      }
    }
    return { number: index + 1, sourceId, required, accepted, status, photo: last, rejected };
  });
  // Снимки без sourceId не входят в задания точек. Отклонённый такой кадр
  // префектура возвращает на весь объект — то же правило действует на карте.
  const unbound = sourceIds.length ? (byPoint.get(null) || []) : [];
  const unboundLast = unbound.at(-1) || null;
  return {
    points,
    unboundLast,
    unboundRework: unboundLast?.reviewStatus === 'rejected' ? unboundLast : null,
  };
}

/** Строка объекта для сводки: счёт точек и статус кабинета. */
export function summarizeReviewObject(row) {
  const { points, unboundLast, unboundRework } = reviewPointStates(row);
  // «Загружено» — точки с действующим кадром: принятым, на проверке или частично
  // снятым. Отклонённая точка пуста, как слот на доработке в сводке парковок.
  const filled = points.filter((point) => point.status === 'closed' || point.status === 'review' || point.status === 'progress').length
    + (unboundLast && unboundLast.reviewStatus !== 'rejected' ? 1 : 0);
  const accepted = points.filter((point) => point.status === 'closed').length;
  const review = points.filter((point) => point.status === 'review').length
    + (unboundLast?.reviewStatus === 'pending_review' ? 1 : 0);
  const rework = points.filter((point) => point.status === 'rework').length + (unboundRework ? 1 : 0);
  const closedAll = points.length > 0 && points.every((point) => point.status === 'closed') && !unboundRework;
  const hasPhoto = filled > 0;
  const status = rework
    ? 'rework'
    : closedAll
      ? 'closed'
      : review
        ? 'review'
        : hasPhoto
          ? 'progress'
          : 'empty';
  return {
    key: row.object_key,
    id: row.odh_id || row.object_key,
    label: row.label || row.object_key,
    type: row.object_type,
    typeLabel: REVIEW_TYPE_LABELS[row.object_type] || row.object_type,
    group: reportingDistrict(row),
    district: row.district || '',
    holder: row.balance_holder || '',
    required: points.length,
    filled,
    accepted,
    pending: review,
    rework,
    status,
    statusLabel: STATUS_LABELS[status],
    lastPhotoAt: latest(activePhotos(row).map((photo) => photo.uploadedAt)),
    points,
    unboundRework,
  };
}

const tally = (rows, label) => ({
  label,
  objects: rows.length,
  required: rows.reduce((sum, row) => sum + row.required, 0),
  filled: rows.reduce((sum, row) => sum + row.filled, 0),
  accepted: rows.reduce((sum, row) => sum + row.accepted, 0),
  pending: rows.reduce((sum, row) => sum + row.pending, 0),
  rework: rows.reduce((sum, row) => sum + row.rework, 0),
  closed: rows.filter((row) => row.status === 'closed').length,
  empty: rows.filter((row) => row.status === 'empty').length,
  review: rows.filter((row) => row.status === 'review').length,
  reworkObjects: rows.filter((row) => row.status === 'rework').length,
  lastPhotoAt: latest(rows.map((row) => row.lastPhotoAt)),
});

/**
 * Чистый расчёт сводки: Excel только раскладывает числа по листам.
 * Районы идут по алфавиту, «АвД САО» — последней строкой, как во всех
 * остальных выгрузках округа.
 */
export function summarizeReview({ rows, type = null, generatedAt = new Date() }) {
  const objects = (rows || [])
    .filter((row) => REVIEW_TYPES.includes(row.object_type))
    .filter((row) => !type || row.object_type === type)
    .map(summarizeReviewObject)
    .sort((left, right) => left.group.localeCompare(right.group, 'ru')
      || TYPE_ORDER.get(left.type) - TYPE_ORDER.get(right.type)
      || left.label.localeCompare(right.label, 'ru'));
  const names = [...new Set(objects.map((row) => row.group))]
    .sort((left, right) => {
      if ((left === AUTODOR_HOLDER) !== (right === AUTODOR_HOLDER)) return left === AUTODOR_HOLDER ? 1 : -1;
      return left.localeCompare(right, 'ru');
    });
  const groupRows = names.map((name) => tally(objects.filter((row) => row.group === name), name));
  const types = type ? [type] : REVIEW_TYPES;
  const typeRows = types.map((kind) => tally(objects.filter((row) => row.type === kind), REVIEW_TYPE_LABELS[kind]));
  return {
    type,
    generatedAt,
    objectRows: objects,
    groupRows,
    typeRows,
    total: tally(objects, 'Итого по САО'),
  };
}

/* ---------------------------------------------------------------- оформление */

// Палитра и сетка — те же, что у эталона сводки по парковкам.
const HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123A32' } };
const TITLE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const STATUS_FILL = {
  closed: 'FFD8F0DE',
  review: 'FFDCE8FB',
  progress: 'FFFFF1C2',
  rework: 'FFF9DCD6',
  empty: 'FFE9ECEF',
};
const THIN = { style: 'thin' };
const GRID = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const CENTER = { horizontal: 'center', vertical: 'middle' };
const LINK = { name: 'Calibri', size: 11, color: { argb: 'FF0C5AA6' } };

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

// Шапка эталона: те же слова и порядок колонок, что в сводке по парковкам.
const SUMMARY_TITLES = Object.freeze([
  'Всего Объектов', 'Объектов закрыто', 'Объектов без фото',
  'Обьектов на проверке', 'Обьектов на доработке ', '% принято', 'Последнее фото',
]);
const summaryValues = (row) => [
  row.objects, row.closed, row.empty, row.review, row.reworkObjects,
  percent(row.accepted, row.required), dateText(row.lastPhotoAt),
];

const MAP_PAGES = Object.freeze({
  stop: { page: 'stops.html', dataset: 'stops' },
  pp: { page: 'pp.html', dataset: 'pp' },
  entrance: { page: 'entrances.html', dataset: 'entrances' },
});
const mapLink = (object, base) => {
  const page = MAP_PAGES[object.type] || MAP_PAGES.stop;
  return { text: 'Открыть', hyperlink: `${base}/${page.page}?dataset=${page.dataset}` };
};

/** Книга Excel по фото остановок, ПП и подъездов — формат эталона парковок. */
export async function buildReviewReport(summary, { mapUrl = 'https://hainox.github.io/karta-sao/object-maps', generatedAt = summary.generatedAt } = {}) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  book.created = generatedAt;
  const day = dateText(generatedAt);
  const columns = SUMMARY_TITLES.length + 1;

  const overview = book.addWorksheet('Свод по районам');
  overview.columns = [{ width: 28 }, ...SUMMARY_TITLES.map((_, index) => ({ width: index === SUMMARY_TITLES.length - 1 ? 17 : 12 }))];
  const title = summary.type ? TYPE_TITLES[summary.type] : ALL_TITLE;
  titleBlock(overview, columns, `Свод по фото ${title} на ${day}`,
    'Точки съёмки: принято — снимок проверен префектурой; на доработке — снимок отклонён, точка ждёт нового. У ПП два кадра на точку.');
  header(overview, 4, ['Район / организация', ...SUMMARY_TITLES]);
  let rowNumber = 5;
  const writeRows = (list, bold) => {
    for (const row of list) {
      const excelRow = overview.getRow(rowNumber++);
      excelRow.values = [row.label, ...summaryValues(row)];
      gridRow(excelRow, columns, { bold });
      excelRow.getCell(7).numFmt = '0%';
    }
  };
  writeRows(summary.groupRows, false);
  writeRows([summary.total], true);
  overview.addConditionalFormatting({ ref: `G5:G${rowNumber - 1}`, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FF0C7A5A' } }] });
  rowNumber += 1;
  header(overview, rowNumber++, ['Вид объекта', ...SUMMARY_TITLES]);
  writeRows(summary.typeRows, false);
  overview.views = [{ state: 'frozen', ySplit: 4 }];

  const objects = book.addWorksheet('Объекты');
  objects.columns = [26, 50, 28, 22, 12, 11, 10, 12, 12, 14, 17, 12].map((width) => ({ width }));
  header(objects, 1, ['Вид', 'Название', 'ID', 'Ответственный', 'Фото требуется', 'Загружено', 'Принято', 'На проверке', 'На доработке', 'Статус', 'Последнее фото', 'На карте']);
  for (const row of summary.objectRows) {
    const excelRow = objects.addRow([row.typeLabel, row.label, row.id, row.group, row.required, row.filled, row.accepted, row.pending, row.rework, row.statusLabel, dateText(row.lastPhotoAt), mapLink(row, mapUrl)]);
    gridRow(excelRow, 12);
    excelRow.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[row.status] } };
    excelRow.getCell(12).font = LINK;
  }
  objects.views = [{ state: 'frozen', ySplit: 1 }];
  objects.autoFilter = { from: 'A1', to: 'L1' };

  const rework = book.addWorksheet('На доработке');
  rework.columns = [26, 50, 10, 60, 17, 12].map((width) => ({ width }));
  header(rework, 1, ['Ответственный', 'Объект', 'Точка', 'Что исправить', 'Отклонено', 'На карте']);
  let reworkRows = 0;
  for (const row of summary.objectRows) {
    for (const point of row.points) {
      if (!point.rejected) continue;
      const excelRow = rework.addRow([row.group, row.label, point.number, point.rejected.reviewReason || 'Причина не указана', dateText(point.rejected.reviewedAt), mapLink(row, mapUrl)]);
      gridRow(excelRow, 6, { wrap: true });
      excelRow.getCell(6).font = LINK;
      reworkRows += 1;
    }
    if (row.unboundRework) {
      const excelRow = rework.addRow([row.group, row.label, '—', row.unboundRework.reviewReason || 'Причина не указана', dateText(row.unboundRework.reviewedAt), mapLink(row, mapUrl)]);
      gridRow(excelRow, 6, { wrap: true });
      excelRow.getCell(6).font = LINK;
      reworkRows += 1;
    }
  }
  rework.views = [{ state: 'frozen', ySplit: 1 }];
  if (reworkRows) rework.autoFilter = { from: 'A1', to: 'F1' };
  else gridRow(rework.addRow(['Точек на доработке нет.']), 6);

  return Buffer.from(await book.xlsx.writeBuffer());
}
