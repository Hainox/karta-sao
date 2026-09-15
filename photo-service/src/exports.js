import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { reportPayload } from './reports.js';
import { completionMix, summarizeByDistrict, uploadDynamics } from './report.js';
import { objectTypeLabel, percentLabel, statusBandLabel, OBJECT_TYPES } from './labels.js';
import {
  CHART_COLORS, bandColor, drawBarRow, drawBandChip, drawColumns, drawGauge, drawStackedBar, section,
} from './pdf-charts.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mediaRoot } from './storage.js';

// PDFKit's built-in Helvetica cannot encode Cyrillic: the text is written with a
// WinAnsi mapping and no ToUnicode table, so the report renders and copies as
// garbage. A bundled TTF with Cyrillic fixes both reading and copy-paste.
const PDF_FONT_PATH = fileURLToPath(new URL('../assets/fonts/PT_Sans-Web-Regular.ttf', import.meta.url));
export const PDF_FONT_NAME = 'report-body';
const MARGIN = 42;
const DYNAMICS_DAYS = 14;

export async function buildExcel(rows) {
  const payload = reportPayload(rows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SAO photo service';
  workbook.created = new Date();
  const summary = workbook.addWorksheet('Сводка');
  summary.columns = [{ header: 'Показатель', key: 'metric', width: 36 }, { header: 'Значение', key: 'value', width: 18 }];
  const summaryRows = [
    ['Сформирован', new Date().toLocaleString('ru-RU')],
    ['Версия набора объектов', payload.sourceVersions.join(', ') || 'не указана'],
    ['Объектов', payload.overall.totalObjects],
    ['С фото', payload.overall.objectsWithPhoto],
    ['Без фото', payload.overall.objectsWithoutPhoto],
    ['Завершено', payload.overall.completedObjects],
    ['На проверке', payload.overall.pendingReviewObjects],
    ['Риски GPS', payload.overall.geoRiskObjects],
    ['Выполнение', percentLabel(payload.overall.completionPercent)],
    ['Статус', statusBandLabel(payload.overall.statusBand)],
  ];
  summary.addRows(summaryRows);

  // Полосы в ячейках — родная визуализация Excel: она масштабируется и печатается.
  const percentRow = 1 + summaryRows.findIndex(([label]) => label === 'Выполнение') + 1;
  summary.addConditionalFormatting({
    ref: `B${percentRow}:B${percentRow}`,
    rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 100 }], color: { argb: 'FF1C7A55' } }],
  });

  const districts = summarizeByDistrict(rows);
  if (districts.length > 1) {
    const districtsSheet = workbook.addWorksheet('Районы');
    districtsSheet.columns = [
      { header: 'Район', key: 'district', width: 24 },
      { header: 'Объектов', key: 'total', width: 12 },
      { header: 'Выполнено', key: 'completed', width: 12 },
      { header: 'Частично', key: 'partial', width: 12 },
      { header: 'На проверке', key: 'pending', width: 14 },
      { header: 'Без фото', key: 'empty', width: 12 },
      { header: 'Выполнение', key: 'percent', width: 14 },
      { header: 'Статус', key: 'band', width: 12 },
    ];
    for (const district of districts) {
      const parts = Object.fromEntries(completionMix(district).map((part) => [part.key, part.value]));
      districtsSheet.addRow({
        district: district.district || 'Без района',
        total: district.totalObjects,
        completed: district.completedObjects,
        partial: parts.partial,
        pending: district.pendingReviewObjects,
        empty: parts.empty,
        percent: district.completionPercent === null ? null : Number(district.completionPercent.toFixed(1)),
        band: statusBandLabel(district.statusBand),
      });
    }
    districtsSheet.getRow(1).font = { bold: true };
    districtsSheet.views = [{ state: 'frozen', ySplit: 1 }];
    districtsSheet.autoFilter = { from: 'A1', to: 'H1' };
    const lastDistrict = districtsSheet.rowCount;
    districtsSheet.addConditionalFormatting({
      ref: `G2:G${lastDistrict}`,
      rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 100 }], color: { argb: 'FF1C7A55' } }],
    });
    districtsSheet.addConditionalFormatting({
      ref: `C2:C${lastDistrict}`,
      rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF7FB89F' } }],
    });
  }

  const dynamics = uploadDynamics(rows, { days: DYNAMICS_DAYS });
  const dynamicsSheet = workbook.addWorksheet('Динамика');
  dynamicsSheet.columns = [
    { header: 'Дата', key: 'date', width: 14 },
    { header: 'Загружено за день', key: 'uploaded', width: 20 },
    { header: 'Всего в службе', key: 'cumulative', width: 18 },
  ];
  for (const point of dynamics) dynamicsSheet.addRow(point);
  dynamicsSheet.getRow(1).font = { bold: true };
  dynamicsSheet.views = [{ state: 'frozen', ySplit: 1 }];
  const lastDay = dynamicsSheet.rowCount;
  dynamicsSheet.addConditionalFormatting({
    ref: `B2:B${lastDay}`,
    rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF1C7A55' } }],
  });
  dynamicsSheet.addRow([]);
  dynamicsSheet.addRow([`Загружено за ${DYNAMICS_DAYS} дней`, dynamics.reduce((sum, point) => sum + point.uploaded, 0)]);
  dynamicsSheet.addRow(['Всего фиксаций', dynamics[dynamics.length - 1].cumulative]);

  const objects = workbook.addWorksheet('Объекты');
  objects.columns = [
    { header: 'Район', key: 'district', width: 20 }, { header: 'Тип', key: 'objectType', width: 14 },
    { header: 'Объект', key: 'label', width: 42 }, { header: 'Ключ', key: 'objectKey', width: 42 },
    { header: 'Подтверждено', key: 'confirmed', width: 16 }, { header: 'На проверке', key: 'pending', width: 14 },
    { header: 'GPS-риск', key: 'geoRisk', width: 12 },
  ];
  for (const row of payload.objects) {
    objects.addRow({ district: row.district || 'Без района', objectType: objectTypeLabel(row.objectType), label: row.label,
      objectKey: row.objectKey, confirmed: row.confirmedPhotos, pending: row.pendingReviewPhotos,
      geoRisk: row.geoRisk ? 'Да' : 'Нет' });
  }
  const photos = workbook.addWorksheet('Фотографии');
  photos.columns = [
    { header: 'Район', key: 'district', width: 20 }, { header: 'Тип', key: 'objectType', width: 14 },
    { header: 'Объект', key: 'label', width: 38 }, { header: 'Статус проверки', key: 'reviewStatus', width: 20 },
    { header: 'GPS', key: 'geoStatus', width: 18 }, { header: 'Дистанция, м', key: 'distanceM', width: 14 },
    { header: 'Исполнитель', key: 'performer', width: 24 }, { header: 'Комментарий', key: 'comment', width: 42 },
    { header: 'Имя файла', key: 'filename', width: 30 },
  ];
  let rowNumber = 2;
  for (const object of payload.objects) {
    for (const photo of object.photos) {
      const excelRow = photos.addRow({ district: object.district || 'Без района', objectType: objectTypeLabel(object.objectType),
        label: object.label, reviewStatus: photo.reviewStatus, geoStatus: photo.geoStatus,
        distanceM: photo.distanceM ?? '—', performer: photo.performer, comment: photo.comment,
        filename: photo.originalFilename });
      excelRow.height = 100;
      try {
        // Only the small preview is embedded: the full set of originals produces a
        // workbook of several hundred megabytes. The original stays on the server.
        // The extension comes from the stored key because a preview is always JPEG
        // even when the original was uploaded as PNG or WebP.
        const key = photo.thumbnailKey || photo.storageKey;
        const buffer = await readFile(`${mediaRoot()}/${key}`);
        const imageId = workbook.addImage({ buffer, extension: key.endsWith('.png') ? 'png' : key.endsWith('.webp') ? 'webp' : 'jpeg' });
        photos.addImage(imageId, { tl: { col: 9, row: rowNumber - 1 }, ext: { width: 150, height: 90 } });
      } catch {
        // Metadata remains exportable when a media file is unavailable; the row is still visible for audit.
      }
      rowNumber += 1;
    }
  }
  return workbook.xlsx.writeBuffer();
}

export function buildPdf(rows) {
  const payload = reportPayload(rows);
  const overall = payload.overall;
  const districts = summarizeByDistrict(rows);
  const dynamics = uploadDynamics(rows, { days: DYNAMICS_DAYS });
  const mix = completionMix(overall);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: 'Краткий отчёт фотофиксации САО' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Without a Cyrillic font the whole report is unreadable and copies as garbage.
    doc.registerFont(PDF_FONT_NAME, PDF_FONT_PATH);
    doc.font(PDF_FONT_NAME);

    const left = MARGIN;
    const width = doc.page.width - MARGIN * 2;
    let y = MARGIN;

    doc.fillColor(CHART_COLORS.ink).fontSize(18).text('Краткий отчёт фотофиксации САО', left, y);
    y = doc.y + 3;
    doc.fillColor(CHART_COLORS.muted).fontSize(8.5)
      .text(`Сформирован: ${new Date().toLocaleString('ru-RU')}   ·   Версия набора объектов: ${payload.sourceVersions.join(', ') || 'не указана'}`, left, y);
    y = doc.y + 18;

    /* ------------------------------------------------------------ выполнение */
    doc.fillColor(CHART_COLORS.ink).fontSize(30).text(percentLabel(overall.completionPercent), left, y);
    const afterNumber = doc.y;
    const chipEnd = drawBandChip(doc, { x: left + 150, y: y + 8, band: overall.statusBand, label: statusBandLabel(overall.statusBand) });
    doc.fillColor(CHART_COLORS.muted).fontSize(9)
      .text(`выполнено ${overall.completedObjects} из ${overall.totalObjects} объектов`, chipEnd + 10, y + 14);
    y = Math.max(afterNumber, y + 44) + 10;

    drawGauge(doc, { x: left, y, width, height: 16, percent: overall.completionPercent, band: overall.statusBand });
    y += 30;

    doc.fillColor(CHART_COLORS.muted).fontSize(9)
      .text(`С фото: ${overall.objectsWithPhoto}   ·   Без фото: ${overall.objectsWithoutPhoto}   ·   На проверке: ${overall.pendingReviewObjects}   ·   Риск GPS: ${overall.geoRiskObjects}`, left, y);
    y = doc.y + 22;

    /* ------------------------------------------------------ состояние объектов */
    y = section(doc, y, 'Состояние объектов');
    y = drawStackedBar(doc, { x: left, y, width, segments: mix });

    /* ------------------------------------------------------------- по типам */
    y = section(doc, y + 6, 'Выполнение по типам объектов');
    for (const type of OBJECT_TYPES) {
      const summary = payload.byType[type];
      y = drawBarRow(doc, {
        x: left, y, labelWidth: 100, trackWidth: width - 200,
        label: objectTypeLabel(type),
        percent: summary.completionPercent,
        band: summary.statusBand,
        value: percentLabel(summary.completionPercent),
        note: `${summary.completedObjects} из ${summary.totalObjects} · ${statusBandLabel(summary.statusBand)}`,
      });
    }

    /* ------------------------------------------------------------- динамика */
    y = section(doc, y + 8, `Динамика загрузки, ${DYNAMICS_DAYS} дней`);
    const uploaded = dynamics.reduce((sum, point) => sum + point.uploaded, 0);
    y = drawColumns(doc, { x: left, y: y + 10, width, height: 78, points: dynamics });
    doc.fillColor(CHART_COLORS.muted).fontSize(8)
      .text(uploaded === 0
        ? 'За период фиксаций не было.'
        : `Загружено за период: ${uploaded}. Всего в службе: ${dynamics[dynamics.length - 1].cumulative}.`, left, y);
    y = doc.y + 18;

    /* ------------------------------------------------------------ по районам */
    if (districts.length > 1) {
      doc.addPage();
      y = MARGIN;
      y = section(doc, y, 'Выполнение по районам');
      for (const district of districts) {
        if (y > doc.page.height - 80) {
          doc.addPage();
          y = MARGIN;
        }
        y = drawBarRow(doc, {
          x: left, y, labelWidth: 130, trackWidth: width - 230,
          label: district.district || 'Без района',
          percent: district.completionPercent,
          band: district.statusBand,
          value: percentLabel(district.completionPercent),
          note: `${district.completedObjects} из ${district.totalObjects}`,
        });
      }
      y += 10;
      doc.fillColor(CHART_COLORS.muted).fontSize(8)
        .text('Районы отсортированы по выполнению. Объекты без района показаны отдельной строкой и не приписаны ни одному району.', left, y, { width });
    }

    doc.end();
  });
}
