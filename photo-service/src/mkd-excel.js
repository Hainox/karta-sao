// Выгрузка отдела МКД в Excel: сводка по районам, подъезды и фото первых этажей.
//
// Книга строится только из таблицы `mkd_floor_photos` и списка подъездов —
// числа фотофиксации сюда не попадают, как и эти фото не попадают в её отчёты.

import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { MKD_CATEGORY, MKD_PHOTO_LIMIT } from './mkd.js';
import { mediaPath, mediaRoot } from './storage.js';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF4F8' } };
// Больше миниатюр книга не встраивает: иначе файл на весь округ станет неподъёмным.
const MAX_EMBEDDED_THUMBNAILS = 3000;

function header(sheet, columns) {
  sheet.columns = columns;
  const row = sheet.getRow(1);
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function moscowTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК)`;
}

/**
 * summary — результат `mkdSummary`; entrances — `{ source_id, district, label }`
 * по всем подъездам; photos — строки `mkd_floor_photos` с районом и адресом.
 */
export async function buildMkdExcel({ summary, entrances = [], photos = [] }, { generatedAt = new Date(), root = mediaRoot() } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'САО · отдел МКД';
  workbook.created = generatedAt;

  const overview = workbook.addWorksheet('Сводка');
  header(overview, [
    { header: '№', key: 'index', width: 6 },
    { header: 'Район', key: 'district', width: 26 },
    { header: 'Подъездов', key: 'total', width: 12 },
    { header: `С фото «${MKD_CATEGORY}»`, key: 'withPhoto', width: 16 },
    { header: 'Без фото', key: 'without', width: 12 },
    { header: '%', key: 'percent', width: 8 },
    { header: 'Фото всего', key: 'photos', width: 12 },
  ]);
  summary.byDistrict.forEach((row, index) => overview.addRow({ index: index + 1, ...row }));
  const total = overview.addRow({ district: 'ИТОГО по САО', ...summary.overall });
  total.eachCell((cell) => { cell.font = { bold: true }; cell.fill = TOTAL_FILL; });
  overview.addRow({});
  overview.addRow({ district: `Сформировано: ${moscowTime(generatedAt)}` });
  overview.addRow({ district: `Фото первых этажей — отдельный учёт отдела МКД, до ${MKD_PHOTO_LIMIT} фото на подъезд. В фотофиксацию и «На штаб» не входят.` });

  const photoCount = new Map();
  const lastUpload = new Map();
  for (const photo of photos) {
    photoCount.set(photo.source_id, (photoCount.get(photo.source_id) || 0) + 1);
    const previous = lastUpload.get(photo.source_id);
    if (!previous || new Date(photo.uploaded_at) > new Date(previous)) lastUpload.set(photo.source_id, photo.uploaded_at);
  }
  const list = workbook.addWorksheet('Подъезды');
  header(list, [
    { header: '№', key: 'index', width: 7 },
    { header: 'Район', key: 'district', width: 22 },
    { header: 'Подъезд', key: 'label', width: 60 },
    { header: 'ID точки', key: 'sourceId', width: 14 },
    { header: 'Фото первого этажа', key: 'count', width: 14 },
    { header: 'Последняя загрузка', key: 'last', width: 24 },
  ]);
  list.autoFilter = { from: 'A1', to: 'F1' };
  entrances.forEach((entrance, index) => {
    const count = photoCount.get(entrance.source_id) || 0;
    const row = list.addRow({
      index: index + 1,
      district: entrance.district || 'Без района',
      label: entrance.label,
      sourceId: entrance.source_id,
      count,
      last: moscowTime(lastUpload.get(entrance.source_id)),
    });
    row.getCell('count').fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: count > 0 ? 'FFD9F2E6' : 'FFFBE3E3' },
    };
  });

  const gallery = workbook.addWorksheet('Фотографии');
  header(gallery, [
    { header: '№', key: 'index', width: 7 },
    { header: 'Район', key: 'district', width: 22 },
    { header: 'Подъезд', key: 'label', width: 50 },
    { header: 'ID точки', key: 'sourceId', width: 14 },
    { header: 'Исполнитель', key: 'performer', width: 22 },
    { header: 'Комментарий', key: 'comment', width: 30 },
    { header: 'Загружено', key: 'uploaded', width: 24 },
    { header: 'Миниатюра', key: 'thumb', width: 24 },
  ]);
  let embedded = 0;
  for (const [index, photo] of photos.entries()) {
    const row = gallery.addRow({
      index: index + 1,
      district: photo.district || 'Без района',
      label: photo.label,
      sourceId: photo.source_id,
      performer: photo.performer,
      comment: photo.comment || '',
      uploaded: moscowTime(photo.uploaded_at),
      thumb: '',
    });
    const key = photo.thumbnail_key;
    if (!key || embedded >= MAX_EMBEDDED_THUMBNAILS) continue;
    try {
      const buffer = await readFile(mediaPath(key, root));
      const imageId = workbook.addImage({ buffer, extension: key.endsWith('.png') ? 'png' : key.endsWith('.webp') ? 'webp' : 'jpeg' });
      row.height = 72;
      gallery.addImage(imageId, { tl: { col: 7, row: row.number - 1 }, ext: { width: 120, height: 90 } });
      embedded += 1;
    } catch {
      row.getCell('thumb').value = 'нет файла';
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
