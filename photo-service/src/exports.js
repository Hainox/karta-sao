import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { reportPayload } from './reports.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mediaRoot } from './storage.js';

// PDFKit's built-in Helvetica cannot encode Cyrillic: the text is written with a
// WinAnsi mapping and no ToUnicode table, so the report renders and copies as
// garbage. A bundled TTF with Cyrillic fixes both reading and copy-paste.
const PDF_FONT_PATH = fileURLToPath(new URL('../assets/fonts/PT_Sans-Web-Regular.ttf', import.meta.url));
export const PDF_FONT_NAME = 'report-body';

const OBJECT_TYPE_LABELS = Object.freeze({ stop: 'Остановки', pp: 'ПП', entrance: 'Подъезды' });
const STATUS_BAND_LABELS = Object.freeze({ low: 'Красный', middle: 'Жёлтый', high: 'Зелёный' });

export function objectTypeLabel(type) {
  return OBJECT_TYPE_LABELS[type] || String(type);
}

// The band is a colour word in the report; the raw code stays internal.
export function statusBandLabel(band) {
  return STATUS_BAND_LABELS[band] || 'нет данных';
}

export function percentLabel(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'нет данных';
  return `${Number(value).toFixed(1).replace('.', ',')} %`;
}

export async function buildExcel(rows) {
  const payload = reportPayload(rows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SAO photo service';
  workbook.created = new Date();
  const summary = workbook.addWorksheet('Сводка');
  summary.columns = [{ header: 'Показатель', key: 'metric', width: 36 }, { header: 'Значение', key: 'value', width: 18 }];
  summary.addRows([
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
  ]);
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
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: 'Краткий отчёт фотофиксации САО' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Without a Cyrillic font the whole report is unreadable and copies as garbage.
    doc.registerFont(PDF_FONT_NAME, PDF_FONT_PATH);
    doc.font(PDF_FONT_NAME);
    doc.fontSize(18).text('Краткий отчёт фотофиксации САО');
    doc.moveDown(0.5).fontSize(11).text(`Сформирован: ${new Date().toLocaleString('ru-RU')}`);
    doc.text(`Версия набора объектов: ${payload.sourceVersions.join(', ') || 'не указана'}`);
    doc.moveDown().fontSize(13).text(`Всего объектов: ${payload.overall.totalObjects}`);
    doc.fontSize(11).text(`С фото: ${payload.overall.objectsWithPhoto}`);
    doc.text(`Без фото: ${payload.overall.objectsWithoutPhoto}`);
    doc.text(`Завершено по норме: ${payload.overall.completedObjects}`);
    doc.text(`На ручной проверке: ${payload.overall.pendingReviewObjects}`);
    doc.text(`GPS-риск, дальше 20 м: ${payload.overall.geoRiskObjects}`);
    doc.text(`Выполнение: ${percentLabel(payload.overall.completionPercent)}`);
    doc.text(`Статус: ${statusBandLabel(payload.overall.statusBand)}`);
    doc.moveDown().fontSize(13).text('По типам объектов');
    for (const [type, summary] of Object.entries(payload.byType)) {
      doc.fontSize(11).text(
        `${objectTypeLabel(type)}: ${summary.completedObjects} из ${summary.totalObjects}, `
        + `${percentLabel(summary.completionPercent)}, статус ${statusBandLabel(summary.statusBand)}`,
      );
    }
    doc.moveDown().fontSize(9).fillColor('#555').text('PDF содержит краткую сводку. Полный перечень объектов, метаданные и фотографии есть в Excel-выгрузке.');
    doc.end();
  });
}
