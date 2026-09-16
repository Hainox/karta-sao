import PDFDocument from 'pdfkit';
import { PDF_FONT_NAME, PDF_FONT_PATH } from './exports.js';
import { reportPayload } from './reports.js';
import {
  HEADQUARTERS_DIRECTION,
  HEADQUARTERS_NOTE,
  headquartersBoard,
  headquartersComment,
  headquartersValues,
} from './headquarters.js';

// Печатная форма листа «На штаб»: те же две таблицы и те же числа в отметках,
// что и в Excel, только отдельным PDF — штабу удобнее распечатать и разослать.
// Числа считает общий модуль headquarters.js, поэтому лист, картинка для Telegram
// и этот PDF не расходятся.
const PAGE = Object.freeze({ size: 'A4', layout: 'landscape', margin: 28 });
const NUMBER_WIDTH = 24;
const LABEL_WIDTH = 168;
const ROW_HEIGHT = 13;
const GROUP_HEIGHT = 20;
const SUBHEADER_HEIGHT = 15;
const CAPTION_HEIGHT = 21;
const LINE_HEIGHT = 11;

const PLAIN_FILL = '#D9D9D9';
const GROUPS = Object.freeze([
  { title: 'Автобусные остановки', fill: '#C9DAF8' },
  { title: 'Пеш.переход', fill: '#D9EAD3' },
  { title: 'Подъезды (Вх. гр.)', fill: '#F9CB9C' },
  { title: 'Итого', fill: PLAIN_FILL },
]);
const SUBHEADER_LABELS = Object.freeze(['Объекты', 'Факт', '%']);
const PERCENT_COLUMNS = Object.freeze([2, 5, 8, 11]);

// Светофор процентов — из эталона заказчика: бледные заливки, смысл несёт число.
const BAND_FILL = Object.freeze({ zero: '#EA9999', low: '#F4CCCC', middle: '#FFF2CC', high: '#D9EAD3' });
const BAND_INK = Object.freeze({ zero: '#B3382B', low: '#B3382B', middle: '#B8791A', high: '#1C7A55' });

const INK = '#243b34';
const MUTED = '#5d6f6a';
const HEADER_INK = '#1f3b57';
const GRID = '#c8d6e0';

/** Пороги и цвета те же, что на листе: без плана полосы нет, точный ноль — свой цвет. */
export function percentBand(percent, plan) {
  if (!plan || percent === null || percent === undefined) return null;
  if (percent <= 0) return 'zero';
  if (percent < 33) return 'low';
  if (percent < 66) return 'middle';
  return 'high';
}

// Проценты целые — как на листе и в картинке для Telegram.
function countText(value) {
  return Number(value).toLocaleString('ru-RU');
}

function percentText(value) {
  return `${value}%`;
}

function cell(doc, x, y, width, height, fill) {
  if (fill) doc.rect(x, y, width, height).fill(fill);
  doc.rect(x, y, width, height).lineWidth(0.5).strokeColor(GRID).stroke();
}

function cellText(doc, value, x, y, width, height, { size = 8, color = INK, align = 'center' } = {}) {
  doc.font(PDF_FONT_NAME).fontSize(size).fillColor(color);
  doc.text(String(value), x + 2, y + (height - size * 1.15) / 2, { width: width - 4, align, lineBreak: false, ellipsis: true });
}

// Jost не содержит знака «№» — он рисуется составным, как в картинке для Telegram.
function numero(doc, centerX, centerY, size) {
  const small = size * 0.62;
  doc.font(PDF_FONT_NAME).fontSize(size);
  const nWidth = doc.widthOfString('N');
  doc.fontSize(small);
  const oWidth = doc.widthOfString('o');
  const left = centerX - (nWidth + oWidth * 0.75) / 2;
  const top = centerY - size * 0.62;
  doc.fillColor(HEADER_INK).fontSize(size).text('N', left, top, { lineBreak: false });
  doc.fontSize(small).text('o', left + nWidth * 0.95, top - size * 0.16, { lineBreak: false });
  doc.rect(left + nWidth * 0.95, top + size * 0.62, oWidth * 0.8, Math.max(0.6, size * 0.08)).fill(HEADER_INK);
}

function drawCaption(doc, layout, y, text) {
  doc.font(PDF_FONT_NAME).fontSize(11).fillColor(HEADER_INK).text(text, layout.x, y + 3);
  return y + CAPTION_HEIGHT;
}

function drawHeader(doc, layout, y) {
  const height = GROUP_HEIGHT + SUBHEADER_HEIGHT;
  let cursor = layout.x;
  cell(doc, cursor, y, NUMBER_WIDTH, height, PLAIN_FILL);
  cell(doc, cursor + NUMBER_WIDTH, y, layout.labelWidth, height, PLAIN_FILL);
  numero(doc, cursor + NUMBER_WIDTH / 2, y + height / 2, 8);
  cellText(doc, 'Район', cursor + NUMBER_WIDTH, y, layout.labelWidth, height, { size: 8, color: HEADER_INK });
  cursor += NUMBER_WIDTH + layout.labelWidth;

  for (const group of GROUPS) {
    const span = layout.columnWidth * 3;
    cell(doc, cursor, y, span, GROUP_HEIGHT, group.fill);
    cellText(doc, group.title, cursor, y, span, GROUP_HEIGHT, { size: 8.5, color: HEADER_INK });
    SUBHEADER_LABELS.forEach((label, index) => {
      const cellX = cursor + layout.columnWidth * index;
      cell(doc, cellX, y + GROUP_HEIGHT, layout.columnWidth, SUBHEADER_HEIGHT, group.fill);
      cellText(doc, label, cellX, y + GROUP_HEIGHT, layout.columnWidth, SUBHEADER_HEIGHT, { size: 7.5, color: HEADER_INK });
    });
    cursor += span;
  }
  return y + height;
}

// Значения строки: отметки по видам и итог, проценты — со светофором.
function drawValues(doc, layout, y, counts, { size, color }) {
  const values = headquartersValues(counts);
  let cursor = layout.x + NUMBER_WIDTH + layout.labelWidth;
  values.forEach((value, index) => {
    const isPercent = PERCENT_COLUMNS.includes(index);
    const band = isPercent ? percentBand(value, values[index - 2]) : null;
    cell(doc, cursor, y, layout.columnWidth, ROW_HEIGHT, band ? BAND_FILL[band] : null);
    cellText(doc, isPercent ? percentText(value) : countText(value), cursor, y, layout.columnWidth, ROW_HEIGHT, {
      size,
      color: band ? BAND_INK[band] : color,
    });
    cursor += layout.columnWidth;
  });
}

function drawRow(doc, layout, y, { number, label, counts }) {
  cell(doc, layout.x, y, NUMBER_WIDTH, ROW_HEIGHT, null);
  cellText(doc, number, layout.x, y, NUMBER_WIDTH, ROW_HEIGHT, { size: 7.8 });
  cell(doc, layout.x + NUMBER_WIDTH, y, layout.labelWidth, ROW_HEIGHT, null);
  cellText(doc, label, layout.x + NUMBER_WIDTH, y, layout.labelWidth, ROW_HEIGHT, { size: 7.8 });
  drawValues(doc, layout, y, counts, { size: 7.8, color: INK });
  return y + ROW_HEIGHT;
}

function drawTotalRow(doc, layout, y, counts) {
  const labelWidth = NUMBER_WIDTH + layout.labelWidth;
  cell(doc, layout.x, y, labelWidth, ROW_HEIGHT, null);
  cellText(doc, 'ИТОГО по САО', layout.x, y, labelWidth, ROW_HEIGHT, { size: 8, color: HEADER_INK });
  drawValues(doc, layout, y, counts, { size: 8, color: HEADER_INK });
  return y + ROW_HEIGHT;
}

/**
 * Таблица целиком: подпись, шапка, строки и «ИТОГО по САО». Если строки не
 * помещаются — шапка повторяется на новой странице.
 */
function drawTable(doc, layout, y, { caption, names, counts, total }) {
  y = drawCaption(doc, layout, y, caption);
  y = drawHeader(doc, layout, y);
  names.forEach((name, index) => {
    if (y + ROW_HEIGHT > layout.bottom) {
      doc.addPage();
      y = drawHeader(doc, layout, PAGE.margin);
    }
    y = drawRow(doc, layout, y, { number: index + 1, label: name, counts: counts[index] });
  });
  if (y + ROW_HEIGHT > layout.bottom) {
    doc.addPage();
    y = drawHeader(doc, layout, PAGE.margin);
  }
  return drawTotalRow(doc, layout, y, total);
}

function drawComment(doc, layout, y, lines) {
  const needed = lines.reduce((sum, line) => sum + LINE_HEIGHT, 0) + 8;
  if (y + needed > layout.bottom) {
    doc.addPage();
    y = PAGE.margin;
  }
  lines.forEach((line, index) => {
    const size = index === 0 ? 8 : 9;
    doc.font(PDF_FONT_NAME).fontSize(size).fillColor(index === 0 ? MUTED : INK);
    const height = doc.heightOfString(line || ' ', { width: layout.width });
    doc.text(line || '', layout.x, y, { width: layout.width });
    y += Math.max(LINE_HEIGHT, height);
  });
  return y + 6;
}

function drawNote(doc, layout, y) {
  const size = 7.5;
  doc.font(PDF_FONT_NAME).fontSize(size).fillColor(MUTED);
  const height = doc.heightOfString(HEADQUARTERS_NOTE, { width: layout.width });
  if (y + height > layout.bottom) {
    doc.addPage();
    y = PAGE.margin;
  }
  doc.text(HEADQUARTERS_NOTE, layout.x, y, { width: layout.width });
  return y + height;
}

function pageHeader(doc, { generatedAt, sourceVersions }) {
  const x = PAGE.margin;
  doc.font(PDF_FONT_NAME).fontSize(15).fillColor(HEADER_INK);
  doc.text(`${HEADQUARTERS_DIRECTION} — таблица на штаб`, x, PAGE.margin);
  doc.font(PDF_FONT_NAME).fontSize(8).fillColor(MUTED);
  doc.text(
    `Сформирован: ${generatedAt.toLocaleString('ru-RU')} (МСК)   ·   Версия набора объектов: ${sourceVersions.join(', ') || 'не указана'}`,
    x, PAGE.margin + 20,
  );
  return PAGE.margin + 42;
}

/**
 * Состав печатной формы: сверху районы в исходном порядке — по этой таблице
 * сверяют числа с выгрузкой, ниже та же таблица по убыванию «Итого, %» — именно
 * она уходит в штаб. Числа берёт общий модуль, поэтому лист «На штаб», картинка
 * для Telegram и этот PDF не расходятся.
 */
export function headquartersPdfTables(rows) {
  const payload = reportPayload(rows);
  const board = headquartersBoard(payload);
  return {
    board,
    sourceVersions: payload.sourceVersions,
    tables: [
      { caption: 'По районам — сверка с выгрузкой', names: board.names, counts: board.counts, total: board.total },
      {
        caption: 'По убыванию «Итого, %» — эта таблица летит в штаб',
        names: board.sorted.map((item) => item.name),
        counts: board.sorted.map((item) => item.counts),
        total: board.total,
      },
    ],
  };
}

/**
 * Печатная форма листа «На штаб»: две таблицы, комментарий для рассылки и
 * примечание о единице учёта.
 */
export function buildHeadquartersPdf(rows) {
  const tables = headquartersPdfTables(rows);
  const generatedAt = new Date();
  const commentLines = headquartersComment(tables.board, { generatedAt });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ ...PAGE, info: { Title: `${HEADQUARTERS_DIRECTION} — таблица на штаб` } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont(PDF_FONT_NAME, PDF_FONT_PATH);

    const x = PAGE.margin;
    const width = doc.page.width - x * 2;
    const layout = {
      x,
      width,
      labelWidth: LABEL_WIDTH,
      columnWidth: (width - NUMBER_WIDTH - LABEL_WIDTH) / 12,
      bottom: doc.page.height - PAGE.margin - 18,
    };

    let y = pageHeader(doc, { generatedAt, sourceVersions: tables.sourceVersions });
    tables.tables.forEach((table, index) => {
      // Вторая таблица начинается со своей страницы: так её удобно отправить штабу.
      if (index > 0) {
        doc.addPage();
        y = PAGE.margin;
      }
      y = drawTable(doc, layout, y, table);
    });

    y = drawComment(doc, layout, y + 12, commentLines);
    drawNote(doc, layout, y);
    doc.end();
  });
}
