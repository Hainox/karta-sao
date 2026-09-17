import PDFDocument from 'pdfkit';
import { PDF_FONT_NAME, PDF_FONT_PATH } from './exports.js';
import { percentBand } from './pdf-headquarters.js';
import { drawBarRow, drawColumns, drawGauge, section } from './pdf-charts.js';
import { dailyComment } from './daily.js';
import { objectTypeLabel } from './labels.js';

// Печатная форма дневного отчёта: числа дня, столбцы по дням, полосы районов и
// разбор лучших/слабых. Графики векторные — резкие в любом масштабе, без картинок.

const PAGE = Object.freeze({ size: 'A4', layout: 'portrait', margin: 42 });
const DIRECTION = 'Единый отчёт по продуктивности округа за день';
const INK = '#243b34';
const MUTED = '#5d6f6a';
const HEADER_INK = '#1f3b57';
const LINE_HEIGHT = 13;

const countText = (value) => Number(value || 0).toLocaleString('ru-RU');
const deltaText = (value) => `${value > 0 ? '+' : ''}${countText(value)}`;

function ensureSpace(doc, y, needed) {
  if (y + needed <= doc.page.height - PAGE.margin) return y;
  doc.addPage();
  return PAGE.margin;
}

function drawMetricLines(doc, x, width, y, lines) {
  for (const [label, value] of lines) {
    y = ensureSpace(doc, y, LINE_HEIGHT);
    doc.font(PDF_FONT_NAME).fontSize(10).fillColor(MUTED).text(label, x, y, { width: width * 0.6, lineBreak: false });
    doc.font(PDF_FONT_NAME).fontSize(10).fillColor(INK).text(value, x + width * 0.6, y, { width: width * 0.4, align: 'right', lineBreak: false });
    y += LINE_HEIGHT;
  }
  return y + 6;
}

/** PDF дневного отчёта: `report` — результат dailyReport(). */
export function buildDailyPdf(report, { generatedAt = new Date() } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ ...PAGE, info: { Title: DIRECTION } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont(PDF_FONT_NAME, PDF_FONT_PATH);

    const x = PAGE.margin;
    const width = doc.page.width - x * 2;
    let y = PAGE.margin;

    doc.font(PDF_FONT_NAME).fontSize(16).fillColor(HEADER_INK).text(DIRECTION, x, y);
    y += 24;
    doc.font(PDF_FONT_NAME).fontSize(10).fillColor(MUTED);
    doc.text(`День: ${report.date} (МСК)   ·   Сформирован: ${generatedAt.toLocaleString('ru-RU')} (МСК)`, x, y);
    y += 26;

    y = section(doc, y, 'Итоги дня');
    y = drawMetricLines(doc, x, width, y, [
      ['Загружено фото', `${countText(report.overall.uploaded)} (${deltaText(report.deltas.uploadedVsYesterday)} к вчера)`],
      ['Подтверждено отметок', `${countText(report.overall.closed)} (${deltaText(report.deltas.closedVsYesterday)} к вчера)`],
      ['Ждут проверки', countText(report.overall.pending)],
      ['Работали районы', `${countText(report.overall.activeDistricts)} из ${countText(report.overall.totalDistricts)}`],
      ['Исполнители', countText(report.overall.activePerformers)],
      ['Средний день за неделю', `${countText(report.deltas.weekAverageUploaded)} фото, ${countText(report.deltas.weekAverageClosed)} отметок`],
    ]);

    y = ensureSpace(doc, y, 120);
    y = section(doc, y, `Динамика загрузки, ${report.dynamics.length} дней`);
    y = drawColumns(doc, { x, y, width, height: 92, points: report.dynamics });

    y = ensureSpace(doc, y, 60);
    y = section(doc, y, 'Выполнение округа');
    const percent = report.overall.cumulativePercent;
    y = drawGauge(doc, { x, y, width: width - 90, height: 16, percent, band: percentBand(percent, 1) });
    doc.font(PDF_FONT_NAME).fontSize(10).fillColor(INK).text(`${percent} % отметок закрыто`, x + width - 84, y - 14, { width: 84, align: 'right' });
    y += 16;

    y = ensureSpace(doc, y, 80);
    y = section(doc, y, `Районы за ${report.date}`);
    const maxClosed = Math.max(1, ...report.districts.map((entry) => entry.closedPoints));
    if (!report.districts.length) {
      doc.font(PDF_FONT_NAME).fontSize(10).fillColor(MUTED).text('За день загрузок не было.', x, y);
      y += LINE_HEIGHT;
    }
    for (const entry of report.districts) {
      y = ensureSpace(doc, y, 24);
      y = drawBarRow(doc, {
        x,
        y,
        labelWidth: 150,
        trackWidth: width - 320,
        label: entry.district,
        percent: Math.round((entry.closedPoints / maxClosed) * 100),
        band: percentBand(entry.cumulativePercent, 1),
        value: `${countText(entry.closedPoints)} отм. / ${countText(entry.uploaded)} фото`,
        note: `всего ${entry.cumulativePercent} %`,
      });
    }

    y = ensureSpace(doc, y, 90);
    y = section(doc, y, 'Виды объектов за день');
    for (const entry of report.types) {
      y = ensureSpace(doc, y, LINE_HEIGHT);
      doc.font(PDF_FONT_NAME).fontSize(10).fillColor(INK)
        .text(`${objectTypeLabel(entry.objectType)}: загружено ${countText(entry.uploaded)}, подтверждено ${countText(entry.closed)}`, x, y);
      y += LINE_HEIGHT;
    }
    y += 6;

    y = ensureSpace(doc, y, 90);
    y = section(doc, y, 'Комментарий к рассылке');
    for (const [index, line] of dailyComment(report, { generatedAt }).entries()) {
      y = ensureSpace(doc, y, LINE_HEIGHT);
      doc.font(PDF_FONT_NAME).fontSize(index === 0 ? 8 : 10).fillColor(index === 0 ? MUTED : INK);
      const height = doc.heightOfString(line || ' ', { width });
      doc.text(line || '', x, y, { width });
      y += Math.max(LINE_HEIGHT, height);
    }

    if (report.unassigned.total) {
      y = ensureSpace(doc, y, LINE_HEIGHT * 2);
      doc.font(PDF_FONT_NAME).fontSize(8).fillColor(MUTED)
        .text(`Объектов без района: ${countText(report.unassigned.total)} — привязку не меняем, объекты показаны списком в выгрузке.`, x, y, { width });
    }

    doc.end();
  });
}
