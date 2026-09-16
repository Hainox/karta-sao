import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { headquartersComment, headquartersValues } from './headquarters.js';

// Картинка для Telegram: вторая таблица листа «На штаб» — районы по убыванию
// «Итого: факт». В само вложение идёт только таблица: комментарий уходит текстом
// поста, иначе он дублируется и на картинке, и в подписи. Рисуется тем же
// шрифтом, что и PDF-сводка: в образе лежит свободный аналог корпоративного
// Century Gothic.
const FONT_PATH = fileURLToPath(new URL('../assets/fonts/Jost-Regular.ttf', import.meta.url));
const FONT_FAMILY = 'Jost';
let fontRegistered = false;

function ensureFont() {
  if (!fontRegistered) {
    GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
    fontRegistered = true;
  }
}

const COLUMN_WIDTHS = Object.freeze([36, 190, ...Array(12).fill(94)]);
const PADDING = 16;
const GROUP_HEIGHT = 30;
const SUBHEADER_HEIGHT = 26;
const ROW_HEIGHT = 25;
const TOTAL_HEIGHT = 28;

// Группы шапки: номера колонок (с нуля) и заливка из эталона заказчика.
// Jost не содержит знака «№» (единственный пропущенный символ), поэтому он
// рисуется составным: латинская «N» с маленькой «o» и подчёркиванием.
const NUMERO = '№';

const HEADER_GROUPS = Object.freeze([
  { from: 0, to: 0, title: NUMERO, fill: '#D9D9D9' },
  { from: 1, to: 1, title: 'Район', fill: '#D9D9D9' },
  { from: 2, to: 4, title: 'Автобусные остановки', fill: '#C9DAF8' },
  { from: 5, to: 7, title: 'Пеш.переход', fill: '#D9EAD3' },
  { from: 8, to: 10, title: 'Подъезды (Вх. гр.)', fill: '#F9CB9C' },
  { from: 11, to: 13, title: 'Итого', fill: '#D9D9D9' },
]);
const SUBHEADER_LABELS = Object.freeze(['Объекты', 'Факт', '%']);

const BAND_COLORS = Object.freeze({
  zero: '#EA9999', low: '#F4CCCC', middle: '#FFF2CC', high: '#D9EAD3',
});

// Цвет числа на светофоре: на телефоне бледные заливки почти не читаются,
// поэтому сам процент написан насыщенным цветом той же полосы.
const BAND_TEXT = Object.freeze({
  zero: '#B3382B', low: '#B3382B', middle: '#B8791A', high: '#1C7A55',
});
const PERCENT_COLUMNS = Object.freeze([4, 7, 10, 13]);
const PLAN_COLUMNS = Object.freeze([2, 5, 8, 11]);

const INK = '#000000';
const GRID = '#000000';

/** Полоса светофора для процента; без плана полосы нет — ячейку не красим. */
function bandOf(percent, plan) {
  if (plan <= 0) return null;
  if (percent <= 0) return 'zero';
  if (percent < 33) return 'low';
  if (percent < 66) return 'middle';
  return 'high';
}

function cellOffset(index) {
  let offset = PADDING;
  for (let column = 0; column < index; column += 1) offset += COLUMN_WIDTHS[column];
  return offset;
}

function countText(value) {
  return Number(value).toLocaleString('ru-RU');
}

// Пустого процента у вида без плана нет: в таблице стоит прочерк, а не «null%».
function percentText(value) {
  return value === null || value === undefined ? '—' : `${value}%`;
}

/** Знак «№» (U+2116), которого нет в шрифте: «N», маленькая «o» и подчёркивание. */
function drawNumero(ctx, centerX, y, size) {
  const full = `${size}px "${FONT_FAMILY}"`;
  const small = `${Math.round(size * 0.62)}px "${FONT_FAMILY}"`;
  ctx.font = full;
  const nWidth = ctx.measureText('N').width;
  ctx.font = small;
  const oWidth = ctx.measureText('o').width;
  const left = centerX - (nWidth + oWidth * 0.75) / 2;
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = full;
  ctx.fillText('N', left, y);
  ctx.font = small;
  ctx.fillText('o', left + nWidth * 0.98, y - size * 0.3);
  ctx.fillRect(left + nWidth * 0.98, y + size * 0.24, oWidth * 0.85, Math.max(1, Math.round(size * 0.07)));
}

// Кого упомянуть в подписи сводки: руководитель направления должен точно
// увидеть выгрузку в чате. Переопределяется переменной NOTIFY_MENTION.
export const DIGEST_MENTION = process.env.NOTIFY_MENTION ?? '@TomGruz200';

/** Картинка со второй таблицей листа «На штаб» и подписью-комментарием. */
export function renderHeadquartersImage(board, { generatedAt = new Date(), mention = DIGEST_MENTION } = {}) {
  ensureFont();

  const rows = board.sorted;
  const commentLines = headquartersComment(board, { generatedAt });
  const width = PADDING * 2 + COLUMN_WIDTHS.reduce((sum, value) => sum + value, 0);
  const height = PADDING + GROUP_HEIGHT + SUBHEADER_HEIGHT + rows.length * ROW_HEIGHT + TOTAL_HEIGHT;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;

  const stroke = (x, y, w, h, fill) => {
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
    }
    ctx.strokeStyle = GRID;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  };

  const text = (value, x, y, w, { size = 14, color = INK, align = 'center' } = {}) => {
    ctx.font = `${size}px "${FONT_FAMILY}"`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    const offset = align === 'left' ? x + 6 : (align === 'right' ? x + w - 6 : x + w / 2);
    ctx.fillText(String(value), offset, y);
  };

  let y = PADDING / 2;

  // Шапка: строка групп и строка «Объекты / Факт / %».
  for (const group of HEADER_GROUPS) {
    const x = cellOffset(group.from);
    const w = COLUMN_WIDTHS.slice(group.from, group.to + 1).reduce((sum, value) => sum + value, 0);
    stroke(x, y, w, GROUP_HEIGHT, group.fill);
    if (group.title === NUMERO) drawNumero(ctx, x + w / 2, y + GROUP_HEIGHT / 2, 12);
    else text(group.title, x, y + GROUP_HEIGHT / 2, w, { size: 12 });
  }
  y += GROUP_HEIGHT;
  for (let column = 0; column < COLUMN_WIDTHS.length; column += 1) {
    const group = HEADER_GROUPS.find((item) => column >= item.from && column <= item.to);
    const x = cellOffset(column);
    stroke(x, y, COLUMN_WIDTHS[column], SUBHEADER_HEIGHT, group.fill);
    // Подпись берётся по смещению внутри своей группы: иначе тройка «Объекты /
    // Факт / %» сдвигается на каждой следующей группе и выдаёт undefined.
    const label = column < 2 ? [NUMERO, 'Район'][column] : SUBHEADER_LABELS[column - group.from];
    if (label === NUMERO) drawNumero(ctx, x + COLUMN_WIDTHS[column] / 2, y + SUBHEADER_HEIGHT / 2, 11);
    else text(label, x, y + SUBHEADER_HEIGHT / 2, COLUMN_WIDTHS[column], { size: 11 });
  }
  y += SUBHEADER_HEIGHT;

  // Строки районов.
  rows.forEach((row, index) => {
    const values = [index + 1, row.name, ...headquartersValues(row.counts)];
    values.forEach((value, column) => {
      const x = cellOffset(column);
      const percentIndex = PERCENT_COLUMNS.indexOf(column);
      const band = percentIndex === -1 ? null : bandOf(value, values[PLAN_COLUMNS[percentIndex]]);
      stroke(x, y, COLUMN_WIDTHS[column], ROW_HEIGHT, band ? BAND_COLORS[band] : null);
      if (column === 1) text(value, x, y + ROW_HEIGHT / 2, COLUMN_WIDTHS[column], { size: 13 });
      else if (percentIndex !== -1) text(percentText(value), x, y + ROW_HEIGHT / 2, COLUMN_WIDTHS[column], { size: 13, color: band ? BAND_TEXT[band] : INK });
      else text(column === 0 ? value : countText(value), x, y + ROW_HEIGHT / 2, COLUMN_WIDTHS[column], { size: 13 });
    });
    y += ROW_HEIGHT;
  });

  // ИТОГО по САО.
  const totalValues = headquartersValues(board.total);
  const labelWidth = COLUMN_WIDTHS[0] + COLUMN_WIDTHS[1];
  stroke(PADDING, y, labelWidth, TOTAL_HEIGHT, '#FFFFFF');
  text('ИТОГО по САО', PADDING, y + TOTAL_HEIGHT / 2, labelWidth, { size: 13 });
  totalValues.forEach((value, index) => {
    const column = index + 2;
    const x = cellOffset(column);
    const percentIndex = PERCENT_COLUMNS.indexOf(column);
    const band = percentIndex === -1 ? null : bandOf(value, totalValues[PLAN_COLUMNS[percentIndex] - 2]);
    stroke(x, y, COLUMN_WIDTHS[column], TOTAL_HEIGHT, band ? BAND_COLORS[band] : null);
    const label = percentIndex !== -1 ? percentText(value) : countText(value);
    text(label, x, y + TOTAL_HEIGHT / 2, COLUMN_WIDTHS[column], { size: 13, color: band ? BAND_TEXT[band] : INK });
  });
  y += TOTAL_HEIGHT;

  // Упоминание идёт последней строкой подписи: фиксированная шапка комментария
  // не меняется, а в само вложение попадает только таблица.
  const caption = [...commentLines, ...(mention ? ['', mention] : [])].join('\n');

  return { png: canvas.toBuffer('image/png'), caption };
}
