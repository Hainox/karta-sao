import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

// Диаграмма динамики для книги Excel. ExcelJS не умеет встраивать настоящие
// диаграммы, поэтому рисуем картинку тем же шрифтом, что PDF и сводка, и кладём
// её на лист как изображение: числа под ней всё равно остаются в ячейках.
const FONT_PATH = fileURLToPath(new URL('../assets/fonts/Jost-Regular.ttf', import.meta.url));
const FONT_FAMILY = 'Jost';
let fontRegistered = false;

function ensureFont() {
  if (!fontRegistered) {
    GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
    fontRegistered = true;
  }
}

const INK = '#243b34';
const MUTED = '#5d6f6a';
const GRID = '#d5ded8';
const UPLOADED = '#1c7a55';
const CLOSED = '#1f3b57';

const PADDING = 28;
const TITLE_HEIGHT = 34;
const LEGEND_HEIGHT = 24;
const AXIS_HEIGHT = 26;
// Зазор между подписью шкалы и началом области графика.
const TICK_GAP = 6;

function countText(value) {
  return Number(value || 0).toLocaleString('ru-RU');
}

/** Колонки «загружено / подтверждено» по дням — то, что видно в отчёте за день. */
export function renderDailyChartImage(report, { width = 1180, height = 400 } = {}) {
  ensureFont();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const points = report.dynamics || [];
  const plotTop = PADDING + TITLE_HEIGHT + LEGEND_HEIGHT;
  const plotHeight = height - plotTop - AXIS_HEIGHT - PADDING;
  const max = Math.max(1, ...points.map((point) => Math.max(point.uploaded, point.closed)));
  // Подписи шкалы шире левого поля, поэтому меряем самую длинную и отдаём ей
  // место: иначе «5 602» обрезалось краем картинки до «602».
  ctx.font = `11px "${FONT_FAMILY}"`;
  const tickValues = Array.from({ length: 5 }, (_, step) => Math.round((max / 4) * step));
  const tickWidth = Math.max(...tickValues.map((value) => ctx.measureText(countText(value)).width));
  const plotLeft = PADDING + Math.ceil(tickWidth) + TICK_GAP;
  const plotWidth = width - plotLeft - PADDING;

  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `600 20px "${FONT_FAMILY}"`;
  ctx.fillText(`Динамика за ${points.length} дней — ${report.date}`, PADDING, PADDING + 14);

  // Легенда: цвет подписан словом, одним цветом смысл не передаётся.
  let legendX = PADDING;
  const legendY = PADDING + TITLE_HEIGHT + 4;
  const legend = [
    { label: 'Загружено фото', color: UPLOADED },
    { label: 'Подтверждено отметок', color: CLOSED },
  ];
  ctx.font = `13px "${FONT_FAMILY}"`;
  for (const item of legend) {
    ctx.fillStyle = item.color;
    ctx.fillRect(legendX, legendY, 14, 14);
    ctx.fillStyle = MUTED;
    ctx.fillText(item.label, legendX + 20, legendY + 12);
    legendX += 30 + ctx.measureText(item.label).width;
  }

  // Сетка по значениям: пять уровней от нуля до максимума.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = MUTED;
  ctx.font = `11px "${FONT_FAMILY}"`;
  for (let step = 0; step <= 4; step += 1) {
    const y = plotTop + plotHeight - (plotHeight / 4) * step;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y + 0.5);
    ctx.lineTo(plotLeft + plotWidth, y + 0.5);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(countText(tickValues[step]), plotLeft - TICK_GAP, y + 4);
    ctx.textAlign = 'left';
  }

  const slot = plotWidth / Math.max(1, points.length);
  const barWidth = Math.max(6, Math.min(18, slot * 0.28));
  points.forEach((point, index) => {
    const centerX = plotLeft + slot * index + slot / 2;
    const baseline = plotTop + plotHeight;
    for (const [order, value, color] of [[-1, point.uploaded, UPLOADED], [1, point.closed, CLOSED]]) {
      const barHeight = value === 0 ? 0 : Math.max(3, (value / max) * plotHeight);
      if (barHeight === 0) continue;
      const x = centerX + (order < 0 ? -barWidth - 2 : 2);
      ctx.fillStyle = color;
      ctx.fillRect(x, baseline - barHeight, barWidth, barHeight);
      ctx.fillStyle = INK;
      ctx.font = `11px "${FONT_FAMILY}"`;
      ctx.textAlign = 'center';
      ctx.fillText(countText(value), x + barWidth / 2, baseline - barHeight - 5);
    }
    ctx.fillStyle = MUTED;
    ctx.font = `11px "${FONT_FAMILY}"`;
    ctx.textAlign = 'center';
    const [year, month, day] = point.date.split('-');
    ctx.fillText(`${day}.${month}`, centerX, baseline + 18);
  });

  return canvas.toBuffer('image/png');
}
