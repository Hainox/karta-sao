import ExcelJS from 'exceljs';
import { bandFor } from './bands.js';
import { objectTypeLabel } from './labels.js';
import { renderDailyChartImage } from './daily-chart.js';
import { dailyComment } from './daily.js';

// Книга «Единый отчёт по продуктивности округа за день»: лист «День» с числами
// и диаграммой, «Динамика» по дням, «Районы дня» от лучших к худшим и «Топы дня».
// Оформление — как в остальных выгрузках: бледные заливки светофора, смысл несёт
// число, проценты целые.

const DIRECTION = 'Единый отчёт по продуктивности округа за день';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
const SECTION_FONT = { bold: true, color: { argb: 'FF1F3B57' }, size: 12 };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF4F8' } };
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAFC' } };
const THIN_BORDER = { style: 'thin', color: { argb: 'FFC8D6E0' } };
const MUTED_FONT = { color: { argb: 'FF708089' }, size: 10 };

// Светофор процентов: общая шкала из bands.js — та же, что в штабной книге,
// PDF и картинке для Telegram.
const PERCENT_BAR = (argb) => ({
  type: 'dataBar', minLength: 0, maxLength: 100,
  cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 100 }], color: { argb },
});

function count(value) {
  return Number(value || 0).toLocaleString('ru-RU');
}

function delta(value) {
  return `${value > 0 ? '+' : ''}${Number(value || 0).toLocaleString('ru-RU')}`;
}

function titleCell(worksheet, row, width, text, font = SECTION_FONT) {
  worksheet.mergeCells(row, 1, row, width);
  const cell = worksheet.getCell(row, 1);
  cell.value = text;
  cell.font = font;
  cell.alignment = { vertical: 'middle' };
}

function headerRow(worksheet, row, headers) {
  headers.forEach((header, index) => {
    const cell = worksheet.getRow(row).getCell(index + 1);
    cell.value = header;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: index === 0 ? 'left' : 'center', wrapText: true };
    cell.border = { bottom: THIN_BORDER };
  });
  worksheet.getRow(row).height = 28;
}

function fillRow(worksheet, row, values, { fill = null, bold = false } = {}) {
  values.forEach((value, index) => {
    const cell = worksheet.getRow(row).getCell(index + 1);
    cell.value = value;
    if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    if (bold) cell.font = { bold: true };
    cell.border = { bottom: THIN_BORDER };
  });
}

/** Книга дневного отчёта: `report` — результат dailyReport(). */
export async function buildDailyExcel(report, { generatedAt = new Date() } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'photo-service';
  workbook.created = generatedAt;

  /* --------------------------------------------------------------- «День» */
  const day = workbook.addWorksheet('День', { views: [{ state: 'frozen', ySplit: 1 }] });
  day.columns = [
    { width: 42 }, { width: 16 }, { width: 16 }, { width: 20 }, { width: 16 }, { width: 16 },
    { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 },
  ];
  titleCell(day, 1, 12, DIRECTION);
  day.getRow(2).getCell(1).value = `День: ${report.date} (МСК)`;
  day.getRow(2).getCell(1).font = MUTED_FONT;
  day.getRow(3).getCell(1).value = `Сформирован: ${generatedAt.toLocaleString('ru-RU')} (МСК)`;
  day.getRow(3).getCell(1).font = MUTED_FONT;

  headerRow(day, 5, ['Показатель', 'За день', 'К вчера', 'К средней недели', 'Всего по округу']);
  const metrics = [
    ['Загружено фото', report.overall.uploaded, report.deltas.uploadedVsYesterday, report.deltas.uploadedVsWeekAverage, ''],
    ['Подтверждено отметок', report.overall.closed, report.deltas.closedVsYesterday, report.deltas.closedVsWeekAverage, ''],
    ['Ждут проверки (загружены сегодня)', report.overall.pending, '', '', ''],
    ['Работали районы', `${report.overall.activeDistricts} из ${report.overall.totalDistricts}`, '', '', ''],
    ['Исполнители', report.overall.activePerformers, '', '', ''],
    ['Выполнено всего', '', '', '', `${report.overall.cumulativePercent} %`],
  ];
  metrics.forEach((values, index) => {
    const [label, perDay, toYesterday, toWeek, total] = values;
    fillRow(day, 6 + index, [
      label,
      perDay,
      typeof toYesterday === 'number' ? delta(toYesterday) : '',
      typeof toWeek === 'number' ? delta(toWeek) : '',
      total,
    ], { fill: index % 2 === 1 ? ZEBRA_FILL.fgColor.argb : null });
  });

  const typesRow = 6 + metrics.length + 1;
  titleCell(day, typesRow, 5, 'По видам объектов за день', { bold: true, size: 11 });
  headerRow(day, typesRow + 1, ['Вид объекта', 'Загружено', 'Подтверждено отметок']);
  report.types.forEach((entry, index) => {
    fillRow(day, typesRow + 2 + index, [objectTypeLabel(entry.objectType), entry.uploaded, entry.closed]);
  });

  const leadersRow = typesRow + 3 + report.types.length;
  titleCell(day, leadersRow, 5, 'Лучшие и слабые за день', { bold: true, size: 11 });
  headerRow(day, leadersRow + 1, ['Район', 'Подтверждено', 'Загружено', 'Выполнено всего']);
  const leaderRows = [
    ...report.leaders.best.map((entry) => [`Лучший: ${entry.district}`, entry.closed, entry.uploaded, `${entry.cumulativePercent} %`]),
    ...report.leaders.worst.map((entry) => [`Слабый: ${entry.district}`, '', '', `${entry.cumulativePercent} %`]),
  ];
  leaderRows.forEach((values, index) => fillRow(day, leadersRow + 2 + index, values));
  if (report.leaders.silent.length) {
    const silentRow = leadersRow + 2 + leaderRows.length + 1;
    titleCell(day, silentRow, 5, `Без загрузок за день: ${report.leaders.silent.join(', ')}`, MUTED_FONT);
  }

  const chart = renderDailyChartImage(report);
  const imageId = workbook.addImage({ buffer: chart, extension: 'png' });
  day.addImage(imageId, { tl: { col: 5.4, row: 3.6 }, ext: { width: 900, height: 305 } });

  /* ------------------------------------------------------------ «Динамика» */
  const dynamics = workbook.addWorksheet('Динамика');
  dynamics.columns = [{ width: 16 }, { width: 22 }, { width: 24 }, { width: 24 }];
  titleCell(dynamics, 1, 4, `Динамика загрузки и подтверждения за ${report.dynamics.length} дней (МСК)`);
  headerRow(dynamics, 3, ['Дата', 'Загружено за день', 'Подтверждено за день', 'Всего загружено']);
  report.dynamics.forEach((point, index) => {
    const row = 4 + index;
    fillRow(dynamics, row, [point.date, point.uploaded, point.closed, point.cumulative], {
      fill: index % 2 === 1 ? ZEBRA_FILL.fgColor.argb : null,
    });
  });
  const dynamicsLast = 3 + report.dynamics.length;
  dynamics.addConditionalFormatting({ ref: `B4:B${dynamicsLast}`, rules: [PERCENT_BAR('FF1C7A55')] });
  dynamics.addConditionalFormatting({ ref: `C4:C${dynamicsLast}`, rules: [PERCENT_BAR('FF1F3B57')] });

  /* --------------------------------------------------------- «Районы дня» */
  const districts = workbook.addWorksheet('Районы дня');
  districts.columns = [
    { width: 26 }, { width: 18 }, { width: 22 }, { width: 24 }, { width: 12 }, { width: 16 }, { width: 20 },
  ];
  titleCell(districts, 1, 7, `Районы за ${report.date} — от лучших к слабым`);
  headerRow(districts, 3, ['Район', 'Загружено за день', 'Подтверждено отметок', 'Подтверждено фото', 'На проверке', 'Выполнено всего, %']);
  report.districts.forEach((entry, index) => {
    const row = 4 + index;
    fillRow(districts, row, [
      entry.district, entry.uploaded, entry.closedPoints, entry.closed, entry.pending, entry.cumulativePercent,
    ], { fill: index % 2 === 1 ? ZEBRA_FILL.fgColor.argb : null });
    const percentCell = districts.getRow(row).getCell(6);
    percentCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bandFor(entry.cumulativePercent, 1).fill } };
  });
  const totalRow = 4 + report.districts.length;
  fillRow(districts, totalRow, [
    'ИТОГО за день',
    report.overall.uploaded,
    report.districts.reduce((sum, entry) => sum + entry.closedPoints, 0),
    report.overall.closed,
    report.overall.pending,
    report.overall.cumulativePercent,
  ], { fill: TOTAL_FILL.fgColor.argb, bold: true });

  const unassignedRow = totalRow + 2;
  titleCell(districts, unassignedRow, 7, `Объектов без района: ${count(report.unassigned.total)} — привязку не меняем, показываем списком`, MUTED_FONT);
  report.unassigned.objects.slice(0, 10).forEach((object, index) => {
    const cell = districts.getRow(unassignedRow + 1 + index).getCell(1);
    cell.value = `${object.label || object.objectKey} · ${object.objectType} · точек ${object.sourcePoints}`;
    cell.font = MUTED_FONT;
  });

  /* ------------------------------------------------------------ «Топы дня» */
  const tops = workbook.addWorksheet('Топы дня');
  tops.columns = [{ width: 34 }, { width: 34 }, { width: 16 }, { width: 18 }];
  titleCell(tops, 1, 4, `Топы за ${report.date}`);
  const sections = [
    ['Лучшие районы дня', ['Район', 'Подтверждено', 'Загружено', 'Выполнено всего']],
    ['Слабый день', ['Район', 'Выполнено всего', '', '']],
  ];
  let cursor = 3;
  for (const [heading, headers] of sections) {
    titleCell(tops, cursor, 4, heading, { bold: true, size: 11, color: { argb: 'FF1F3B57' } });
    const rowValues = heading === 'Лучшие районы дня'
      ? report.leaders.best.map((entry) => [entry.district, entry.closed, entry.uploaded, `${entry.cumulativePercent} %`])
      : report.leaders.worst.map((entry) => [entry.district, `${entry.cumulativePercent} %`, '', '']);
    headerRow(tops, cursor + 1, headers);
    rowValues.forEach((values, index) => fillRow(tops, cursor + 2 + index, values));
    cursor += 4 + rowValues.length;
  }
  titleCell(tops, cursor, 4, 'Исполнители дня', { bold: true, size: 11, color: { argb: 'FF1F3B57' } });
  headerRow(tops, cursor + 1, ['Исполнитель', 'Район', 'Загружено', '']);
  report.performers.slice(0, 10).forEach((entry, index) => {
    fillRow(tops, cursor + 2 + index, [entry.performer, entry.district, entry.uploaded, '']);
  });

  const commentRow = cursor + 3 + Math.min(10, report.performers.length);
  titleCell(tops, commentRow, 4, 'Комментарий к рассылке', { bold: true, size: 11, color: { argb: 'FF1F3B57' } });
  dailyComment(report, { generatedAt }).forEach((line, index) => {
    const cell = tops.getRow(commentRow + 1 + index).getCell(1);
    cell.value = line;
    cell.font = MUTED_FONT;
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
