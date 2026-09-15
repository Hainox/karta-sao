// Векторные графики для PDF-сводки. PDFKit рисует примитивами, поэтому
// диаграммы не тянут зависимостей и печатаются резко в любом масштабе.

export const CHART_COLORS = Object.freeze({
  low: '#b3382b',
  middle: '#b8791a',
  high: '#1c7a55',
  none: '#7a8c86',
  track: '#e6ebe7',
  ink: '#243b34',
  muted: '#5d6f6a',
  line: '#d5ded8',
});

const SEGMENT_COLORS = Object.freeze({
  done: '#1c7a55',
  partial: '#b8791a',
  empty: '#c9d2cc',
});

export function bandColor(band) {
  return CHART_COLORS[band] || CHART_COLORS.none;
}

/** Крупный заголовок раздела. */
export function section(doc, y, title) {
  doc.fillColor(CHART_COLORS.ink).fontSize(12).text(title, 42, y);
  return y + 20;
}

/** Горизонтальная шкала выполнения: дорожка, заполнение по цвету полосы, подпись. */
export function drawGauge(doc, { x, y, width, height = 16, percent, band }) {
  doc.roundedRect(x, y, width, height, height / 2).fill(CHART_COLORS.track);
  const share = Math.max(0, Math.min(1, (Number(percent) || 0) / 100));
  if (share > 0) {
    doc.roundedRect(x, y, Math.max(height, width * share), height, height / 2).fill(bandColor(band));
  }
  return y + height;
}

/** Колонки по дням: подписи дат и значения над столбцами. */
export function drawColumns(doc, { x, y, width, height, points }) {
  const max = Math.max(1, ...points.map((point) => point.uploaded));
  const slot = width / points.length;
  const barWidth = Math.max(4, slot * 0.6);
  const baseline = y + height;
  doc.moveTo(x, baseline).lineTo(x + width, baseline).lineWidth(0.7).strokeColor(CHART_COLORS.line).stroke();

  points.forEach((point, index) => {
    const slotX = x + index * slot + (slot - barWidth) / 2;
    const barHeight = point.uploaded === 0 ? 1.5 : Math.max(3, (point.uploaded / max) * (height - 14));
    doc.rect(slotX, baseline - barHeight, barWidth, barHeight)
      .fill(point.uploaded === 0 ? CHART_COLORS.track : CHART_COLORS.high);
    if (point.uploaded > 0) {
      doc.fillColor(CHART_COLORS.ink).fontSize(7)
        .text(String(point.uploaded), slotX - 6, baseline - barHeight - 10, { width: barWidth + 12, align: 'center' });
    }
    // Подписи дат через одну, иначе они слипаются на узкой полосе.
    if (index % 2 === 0 || index === points.length - 1) {
      doc.fillColor(CHART_COLORS.muted).fontSize(6)
        .text(point.date.slice(8) + '.' + point.date.slice(5, 7), x + index * slot - 8, baseline + 4, { width: slot + 16, align: 'center' });
    }
  });
  return baseline + 18;
}

/** Горизонтальные полосы: подпись, шкала, значение. */
export function drawBarRow(doc, { x, y, labelWidth, trackWidth, label, percent, band, value, note }) {
  doc.fillColor(CHART_COLORS.ink).fontSize(9).text(label, x, y + 3, { width: labelWidth - 8, ellipsis: true });
  const trackX = x + labelWidth;
  drawGauge(doc, { x: trackX, y, width: trackWidth, height: 12, percent: percent ?? 0, band });
  const valueX = trackX + trackWidth + 8;
  doc.fillColor(CHART_COLORS.ink).fontSize(8).text(value, valueX, y + 2, { width: 62 });
  if (note) {
    doc.fillColor(CHART_COLORS.muted).fontSize(7).text(note, valueX, y + 12, { width: 120 });
  }
  return y + 22;
}

/** Составная полоса состояния объектов с подписями под ней. */
export function drawStackedBar(doc, { x, y, width, height = 18, segments }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) {
    doc.rect(x, y, width, height).fill(CHART_COLORS.track);
    doc.fillColor(CHART_COLORS.muted).fontSize(8).text('Объектов нет', x + 6, y + 5);
    return y + height;
  }
  let cursor = x;
  segments.forEach((segment, index) => {
    const share = segment.value / total;
    const segmentWidth = index === segments.length - 1 ? x + width - cursor : width * share;
    doc.rect(cursor, y, Math.max(0, segmentWidth), height).fill(SEGMENT_COLORS[segment.key] || CHART_COLORS.track);
    cursor += segmentWidth;
  });

  let legendX = x;
  doc.fontSize(7.5);
  segments.forEach((segment) => {
    doc.rect(legendX, y + height + 6, 8, 8).fill(SEGMENT_COLORS[segment.key] || CHART_COLORS.track);
    const text = `${segment.label}: ${segment.value}`;
    doc.fillColor(CHART_COLORS.muted).text(text, legendX + 12, y + height + 7);
    legendX += 14 + doc.widthOfString(text) + 14;
  });
  return y + height + 26;
}

/** Цветной значок статуса рядом с текстом: цвет не единственный носитель смысла. */
export function drawBandChip(doc, { x, y, band, label }) {
  const text = label;
  doc.fontSize(10);
  const chipWidth = doc.widthOfString(text) + 16;
  doc.roundedRect(x, y, chipWidth, 18, 9).fill(bandColor(band));
  doc.fillColor('#ffffff').fontSize(10).text(text, x + 8, y + 4, { width: chipWidth - 16, align: 'center' });
  return x + chipWidth;
}
