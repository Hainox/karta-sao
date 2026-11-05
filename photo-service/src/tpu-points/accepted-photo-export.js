import ExcelJS from 'exceljs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { DISTRICTS } from './validation.js';

const LIMIT = 500;
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
const kindNames = { dp: 'Детская площадка', sp: 'Спортивная площадка' };
const dayOf = value => dayFormat.format(new Date(value));
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function selectAcceptedPhotos(rows, { district, kind, from, to }) {
  return rows.filter(row => {
    if (row.photo_status !== 'accepted' || !row.photo_id || district && row.district !== district || kind && row.kind !== kind) return false;
    if (!from && !to) return true;
    if (!row.uploaded_at) return false;
    const day = dayOf(row.uploaded_at);
    return (!from || day >= from) && (!to || day <= to);
  }).sort((a, b) => a.district.localeCompare(b.district, 'ru') || a.label.localeCompare(b.label, 'ru')
    || String(a.point_id).localeCompare(String(b.point_id)));
}

export async function buildAcceptedPhotoWorkbook(rows, loadPhoto, category) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Принятые фото', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = ['Район', 'Вид работ', 'ID объекта / точки', 'Адрес / задание', 'Широта точки', 'Долгота точки', 'Азимут', 'Загружено (МСК)', 'Принято (МСК)', 'Фото', 'Статус фото'];
  sheet.columns = [22, 23, 34, 43, 14, 14, 11, 22, 22, 53, 22].map(width => ({ width }));
  sheet.addRow(headers);
  sheet.autoFilter = { from: 'A1', to: 'K1' };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183C35' } };
  for (const source of rows) {
    const item = sheet.addRow([
      source.district, kindNames[source.kind] || category, String(source.object_id ?? source.point_id), source.label,
      source.latitude, source.longitude, source.heading ?? null,
      source.uploaded_at ? dateTime.format(new Date(source.uploaded_at)) : null,
      source.reviewed_at ? dateTime.format(new Date(source.reviewed_at)) : null, null, 'Принято',
    ]);
    item.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    item.getCell(5).numFmt = item.getCell(6).numFmt = '0.000000';
    const bytes = await loadPhoto(source);
    if (!bytes) { item.getCell(10).value = 'Фото больше недоступно'; continue; }
    let image;
    try { image = await loadImage(bytes); } catch { item.getCell(10).value = 'Фото не удалось прочитать'; continue; }
    const scale = Math.min(1, 350 / image.width, 240 / image.height);
    const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const id = book.addImage({ buffer: canvas.toBuffer('image/jpeg', 85), extension: 'jpeg' });
    item.height = (height + 12) * 0.75;
    sheet.addImage(id, { tl: { col: 9.02, row: item.number - 1 + 0.02 }, ext: { width, height }, editAs: 'oneCell' });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function acceptedPhotoBytes(pool, source, table, pointColumn = 'point_id') {
  // Table and column are fixed by the mounting router, never supplied by the request.
  const { rows } = await pool.query(
    `SELECT photo_bytes FROM ${table} WHERE id = $1 AND ${pointColumn} = $2 AND status = 'accepted'`,
    [source.photo_id, source.point_id],
  );
  return rows[0]?.photo_bytes;
}

// Image decoding is memory-intensive; keep at most one export per process.
let busy = false;
export function mountAcceptedPhotoExport(router, { path = '/accepted.xlsx', prefecture, category, allowKind = false, loadRows, loadPhoto }) {
  router.get(path, prefecture, async (req, res, next) => {
    const { district, kind, from, to } = req.query;
    if ((district !== undefined && !DISTRICTS.has(district))
      || (kind !== undefined && (!allowKind || !Object.hasOwn(kindNames, kind) || typeof kind !== 'string'))
      || (from !== undefined && !validDay(from)) || (to !== undefined && !validDay(to)) || (from && to && from > to)) {
      return res.status(400).json({ error: 'Проверьте район, вид работ и даты загрузки.' });
    }
    if (busy) return res.status(429).json({ error: 'Другая выгрузка уже готовится. Повторите через минуту.' });
    busy = true;
    try {
      const rows = selectAcceptedPhotos(await loadRows(req), { district, kind, from, to });
      res.set('Cache-Control', 'private, no-store');
      if (!rows.length) return res.status(204).end();
      if (rows.length > LIMIT) return res.status(422).json({ error: `Найдено ${rows.length} фото. За один раз можно выгрузить ${LIMIT}; уточните район или даты загрузки.` });
      const file = await buildAcceptedPhotoWorkbook(rows, loadPhoto, category);
      res.set('Content-Disposition', 'attachment; filename="accepted-photos.xlsx"');
      return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(file);
    } catch (error) { next(error); }
    finally { busy = false; }
  });
}
