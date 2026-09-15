import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { reportPayload } from './reports.js';
import { readFile } from 'node:fs/promises';
import { mediaRoot } from './storage.js';

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
    ['Выполнение, %', payload.overall.completionPercent ?? '—'],
    ['Статус', payload.overall.statusBand ?? '—'],
  ]);
  const objects = workbook.addWorksheet('Объекты');
  objects.columns = [
    { header: 'Район', key: 'district', width: 20 }, { header: 'Тип', key: 'objectType', width: 14 },
    { header: 'Объект', key: 'label', width: 42 }, { header: 'Ключ', key: 'objectKey', width: 42 },
    { header: 'Подтверждено', key: 'confirmed', width: 16 }, { header: 'На проверке', key: 'pending', width: 14 },
    { header: 'GPS-риск', key: 'geoRisk', width: 12 },
  ];
  for (const row of payload.objects) {
    objects.addRow({ district: row.district || 'Без района', objectType: row.objectType, label: row.label,
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
      const excelRow = photos.addRow({ district: object.district || 'Без района', objectType: object.objectType,
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
    doc.fontSize(18).text('Краткий отчёт фотофиксации САО');
    doc.moveDown(0.5).fontSize(11).text(`Сформирован: ${new Date().toLocaleString('ru-RU')}`);
    doc.text(`Версия набора объектов: ${payload.sourceVersions.join(', ') || 'не указана'}`);
    doc.moveDown().fontSize(13).text(`Всего объектов: ${payload.overall.totalObjects}`);
    doc.fontSize(11).text(`С фото: ${payload.overall.objectsWithPhoto}`);
    doc.text(`Без фото: ${payload.overall.objectsWithoutPhoto}`);
    doc.text(`Завершено по норме: ${payload.overall.completedObjects}`);
    doc.text(`На ручной проверке: ${payload.overall.pendingReviewObjects}`);
    doc.text(`GPS-риск (>20 м): ${payload.overall.geoRiskObjects}`);
    doc.text(`Выполнение: ${payload.overall.completionPercent ?? '—'}%`);
    doc.text(`Статус: ${payload.overall.statusBand ?? '—'}`);
    doc.moveDown().fontSize(13).text('По типам объектов');
    for (const [type, summary] of Object.entries(payload.byType)) {
      doc.fontSize(11).text(`${type}: ${summary.completedObjects}/${summary.totalObjects}, ${summary.completionPercent ?? '—'}%, статус ${summary.statusBand ?? '—'}`);
    }
    doc.moveDown().fontSize(9).fillColor('#555').text('PDF содержит краткую сводку. Полный перечень объектов, метаданные и фотографии — в Excel-выгрузке.');
    doc.end();
  });
}
