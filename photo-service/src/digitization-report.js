// Свод Excel по оцифровке районных карт: у каждой точки один фотослот.
//
// Общий построитель для двух оцифровок кабинета приёмки районных карт —
// въездных групп (точки съёмки) и детских/спортивных площадок. Формат — эталон
// сводки по парковкам (без ТПУ): «Свод по районам» с жёлтым титулом и
// тёмно-зелёными шапками, лист «Точки» и лист «На доработке» с причиной возврата.
// Единица учёта — точка: закрыта, когда её снимок принят префектурой.
import ExcelJS from 'exceljs';
import { DISTRICTS } from './tpu-points/validation.js';
import { LINK, STATUS_FILL, SUMMARY_TITLES, dateText, gridRow, header, summaryValues, titleBlock } from './review-report.js';

export const DIGITIZATION_STATE_LABELS = Object.freeze({
  empty: 'Нет фото', pending: 'На проверке', accepted: 'Принято', rework: 'На доработке',
});
// Цвета статусов — те же, что в сводке фотофиксации.
const STATE_FILL = { empty: STATUS_FILL.empty, pending: STATUS_FILL.review, accepted: STATUS_FILL.closed, rework: STATUS_FILL.rework };
const DISTRICT_SLUGS = Object.freeze({
  'Аэропорт': 'aeroport', 'Беговой': 'begovoy', 'Бескудниковский': 'beskudnikovskiy',
  'Войковский': 'voykovskiy', 'Восточное Дегунино': 'vostochnoe-degunino',
  'Головинский': 'golovinskiy', 'Дмитровский': 'dmitrovskiy',
  'Западное Дегунино': 'zapadnoe-degunino', 'Коптево': 'koptevo',
  'Левобережный': 'levoberezhnyy', 'Молжаниновский': 'molzhaninovskiy',
  'Савеловский': 'savelovskiy', 'Сокол': 'sokol', 'Тимирязевский': 'timiryazevskiy',
  'Ховрино': 'hovrino', 'Хорошевский': 'horoshevskiy',
});

const iso = (value) => (value ? new Date(value).toISOString() : null);
const latest = (values) => values.map(iso).filter(Boolean).sort().at(-1) || null;
const byName = (left, right) => left.localeCompare(right, 'ru', { numeric: true });

const tally = (rows, label) => {
  const closed = rows.filter((row) => row.state === 'accepted').length;
  return {
    label,
    objects: rows.length,
    closed,
    empty: rows.filter((row) => row.state === 'empty').length,
    review: rows.filter((row) => row.state === 'pending').length,
    reworkObjects: rows.filter((row) => row.state === 'rework').length,
    // summaryValues считает «% принято» как accepted / required.
    accepted: closed,
    required: rows.length,
    lastPhotoAt: latest(rows.map((row) => row.lastPhotoAt)),
  };
};

/**
 * Чистый расчёт свода. points: [{ district, label, kind, state, lastPhotoAt,
 * rejectedComment, rejectedAt }], state ∈ empty | pending | accepted | rework.
 * Все 16 районов идут строками даже без точек; kinds — подписи видов для
 * разбивки (например, детские и спортивные площадки), без них разбивки нет.
 */
export function summarizeDigitization({ points = [], kinds = null, generatedAt = new Date() } = {}) {
  const pointRows = points
    .map((point) => ({ ...point, lastPhotoAt: iso(point.lastPhotoAt), rejectedAt: iso(point.rejectedAt) }))
    .sort((left, right) => byName(left.district, right.district)
      || byName(String(left.kind || ''), String(right.kind || ''))
      || byName(String(left.label), String(right.label)));
  const districtRows = [...DISTRICTS].sort(byName)
    .map((district) => tally(pointRows.filter((row) => row.district === district), district));
  const kindRows = kinds
    ? Object.entries(kinds).map(([kind, label]) => tally(pointRows.filter((row) => row.kind === kind), label))
    : [];
  return { generatedAt, pointRows, districtRows, kindRows, total: tally(pointRows, 'Итого по САО') };
}

const mapLink = (district, base) => ({
  text: 'Открыть',
  hyperlink: `${base}/${DISTRICT_SLUGS[district] ? DISTRICT_SLUGS[district] + '.html' : 'index.html'}`,
});

/** Книга Excel по своду оцифровки; kinds — те же подписи видов, что в расчёте. */
export async function buildDigitizationReport(summary, {
  title, note, kinds = null, pointTitle = 'Точка', mapUrl = 'https://hainox.github.io/karta-sao/districts',
} = {}) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  book.created = summary.generatedAt;
  const columns = SUMMARY_TITLES.length + 1;

  const overview = book.addWorksheet('Свод по районам');
  overview.columns = [{ width: 28 }, ...SUMMARY_TITLES.map((_, index) => ({ width: index === SUMMARY_TITLES.length - 1 ? 17 : 12 }))];
  titleBlock(overview, columns, `${title} на ${dateText(summary.generatedAt)}`, note);
  header(overview, 4, ['Район', ...SUMMARY_TITLES]);
  let rowNumber = 5;
  const writeRows = (list, bold) => {
    for (const row of list) {
      const excelRow = overview.getRow(rowNumber++);
      excelRow.values = [row.label, ...summaryValues(row)];
      gridRow(excelRow, columns, { bold });
      excelRow.getCell(7).numFmt = '0%';
    }
  };
  writeRows(summary.districtRows, false);
  writeRows([summary.total], true);
  overview.addConditionalFormatting({ ref: `G5:G${rowNumber - 1}`, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FF0C7A5A' } }] });
  if (summary.kindRows.length) {
    rowNumber += 1;
    header(overview, rowNumber++, ['Вид объекта', ...SUMMARY_TITLES]);
    writeRows(summary.kindRows, false);
  }
  overview.views = [{ state: 'frozen', ySplit: 4 }];

  // С видами (ДП/СП) в листах появляется колонка «Вид»; без них её нет.
  const kindColumn = (row) => (kinds ? [kinds[row.kind] || row.kind || ''] : []);
  const kindTitle = kinds ? ['Вид'] : [];

  const pointsSheet = book.addWorksheet('Точки');
  const pointTitles = ['Район', ...kindTitle, pointTitle, 'Статус', 'Последнее фото', 'На карте'];
  pointsSheet.columns = [24, ...(kinds ? [22] : []), 40, 16, 17, 12].map((width) => ({ width }));
  header(pointsSheet, 1, pointTitles);
  const statusColumn = pointTitles.indexOf('Статус') + 1;
  for (const row of summary.pointRows) {
    const excelRow = pointsSheet.addRow([row.district, ...kindColumn(row), row.label, DIGITIZATION_STATE_LABELS[row.state], dateText(row.lastPhotoAt), mapLink(row.district, mapUrl)]);
    gridRow(excelRow, pointTitles.length);
    excelRow.getCell(statusColumn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATE_FILL[row.state] } };
    excelRow.getCell(pointTitles.length).font = LINK;
  }
  pointsSheet.views = [{ state: 'frozen', ySplit: 1 }];
  pointsSheet.autoFilter = { from: 'A1', to: { row: 1, column: pointTitles.length } };

  const rework = book.addWorksheet('На доработке');
  const reworkTitles = ['Район', ...kindTitle, pointTitle, 'Что исправить', 'Отклонено', 'На карте'];
  rework.columns = [24, ...(kinds ? [22] : []), 40, 60, 17, 12].map((width) => ({ width }));
  header(rework, 1, reworkTitles);
  const reworkRows = summary.pointRows.filter((row) => row.state === 'rework');
  for (const row of reworkRows) {
    const excelRow = rework.addRow([row.district, ...kindColumn(row), row.label, row.rejectedComment || 'Причина не указана', dateText(row.rejectedAt), mapLink(row.district, mapUrl)]);
    gridRow(excelRow, reworkTitles.length, { wrap: true });
    excelRow.getCell(reworkTitles.length).font = LINK;
  }
  rework.views = [{ state: 'frozen', ySplit: 1 }];
  if (reworkRows.length) rework.autoFilter = { from: 'A1', to: { row: 1, column: reworkTitles.length } };
  else gridRow(rework.addRow(['Точек на доработке нет.']), reworkTitles.length);

  return Buffer.from(await book.xlsx.writeBuffer());
}
