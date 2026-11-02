// Архив фото по оцифровке парковок: папка района → папка объекта → снимки.
//
// Имя снимка — координаты объекта и номер кадра: «55.823600, 37.527748_1.jpg».
// Координаты — метка объекта на карте ТПУ и парковок (каталог tpu-objects.json),
// поэтому у всех кадров одного объекта они одинаковы и различаются номером.
//
// Снимки парковок лежат в базе, а не в медиатоме, и приходят из двух мест:
// фото по назначенным точкам съёмки и фото по заданию (слоты объекта). Отклонённые
// префектурой кадры в архив не идут, у точек — только кадры текущего ракурса.
//
// Раскладка — чистая функция, её проверяют тесты; байты читаются по одному
// снимку прямо во время упаковки, чтобы гигабайты не лежали в памяти.

import { Readable } from 'node:stream';
import { safeSegment } from './photos-archive.js';

export const PARKING_ARCHIVE_PREFIX = 'sao-parking';
const EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/webp': 'webp' });
const FALLBACK_DISTRICT = 'Без района';

/** Папка объекта: название и ID — у разных парковок бывают одинаковые названия. */
export function parkingObjectFolder(object, objectKey) {
  const id = object?.sourceNumber || String(objectKey || '').replace(/^parking:/, '');
  const label = safeSegment(object?.label, 'Парковка', 90);
  return safeSegment(id ? `${label} (${id})` : label, 'Парковка', 110);
}

/** Имя кадра: координаты объекта и номер «_N». */
export function parkingPhotoName(object, index, mimeType) {
  const latitude = Number(object?.lat);
  const longitude = Number(object?.lon);
  const coordinates = Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude || longitude)
    ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
    : 'без координат';
  return `${coordinates}_${index}.${EXTENSIONS[mimeType] || 'jpg'}`;
}

const time = (value) => new Date(value || 0).getTime();

/**
 * Раскладка архива. objects — каталог карты (Map id → объект), photos — кадры
 * без байтов: { source, id, object_key, photo_mime_type, uploaded_at, photo_size, status, slot }.
 * Папка района — ответственный по карте (район или АвД САО).
 */
export function parkingArchiveLayout(objects, photos) {
  const byObject = new Map();
  for (const photo of photos) {
    if (!String(photo.object_key || '').startsWith('parking:')) continue;
    if (!byObject.has(photo.object_key)) byObject.set(photo.object_key, []);
    byObject.get(photo.object_key).push(photo);
  }
  const entries = [];
  const folders = new Set();
  for (const [objectKey, own] of byObject) {
    const object = objects.get(objectKey) || null;
    const district = safeSegment(object?.group || object?.district, FALLBACK_DISTRICT);
    const folder = `${district}/${parkingObjectFolder(object, objectKey)}`;
    folders.add(district);
    folders.add(folder);
    own.sort((left, right) => time(left.uploaded_at) - time(right.uploaded_at) || String(left.id).localeCompare(String(right.id)));
    own.forEach((photo, index) => {
      entries.push({
        path: `${folder}/${parkingPhotoName(object, index + 1, photo.photo_mime_type)}`,
        source: photo.source,
        photoId: photo.id,
        district: object?.group || object?.district || null,
        objectKey,
        label: object?.label || null,
        latitude: Number.isFinite(Number(object?.lat)) ? Number(object.lat) : null,
        longitude: Number.isFinite(Number(object?.lon)) ? Number(object.lon) : null,
        slot: photo.slot ?? null,
        status: photo.status || null,
        uploadedAt: photo.uploaded_at instanceof Date ? photo.uploaded_at.toISOString() : photo.uploaded_at || null,
        byteSize: Number(photo.photo_size) || 0,
      });
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'ru', { numeric: true }));
  return { entries, folders: [...folders].sort((left, right) => left.localeCompare(right, 'ru')) };
}

const POINT_PHOTOS_SQL = `
  SELECT 'point' AS source, f.id, p.object_key, f.photo_mime_type, f.uploaded_at, f.photo_size, f.status, NULL::integer AS slot
    FROM object_photo_point_photos f
    JOIN object_photo_points p ON p.id = f.point_id
   WHERE p.dataset_id = 'sao_tpu_parking' AND p.object_type = 'parking' AND p.retired_at IS NULL
     AND f.assignment_version = p.assignment_version AND coalesce(f.status, 'accepted') <> 'rejected'`;
const SLOT_PHOTOS_SQL = `
  SELECT 'slot' AS source, id, object_key, photo_mime_type, uploaded_at, photo_size, status, slot
    FROM object_slot_photos
   WHERE dataset_id = 'sao_tpu_parking' AND object_key LIKE 'parking:%' AND status IN ('pending', 'accepted')`;
const BYTES_SQL = {
  point: 'SELECT photo_bytes FROM object_photo_point_photos WHERE id = $1',
  slot: 'SELECT photo_bytes FROM object_slot_photos WHERE id = $1',
};

/** Кадры парковок из базы и раскладка архива; байты каждого кадра читает open(). */
export async function loadParkingArchive(pool, objects) {
  const [points, slots] = await Promise.all([pool.query(POINT_PHOTOS_SQL), pool.query(SLOT_PHOTOS_SQL)]);
  const layout = parkingArchiveLayout(objects, [...points.rows, ...slots.rows]);
  for (const entry of layout.entries) {
    // Генератор ленивый: запрос в базу уходит, только когда архиватор дошёл до кадра.
    entry.open = () => Readable.from((async function* read() {
      const { rows } = await pool.query(BYTES_SQL[entry.source], [entry.photoId]);
      if (!rows[0]) throw new Error(`Фото ${entry.photoId} удалено во время сборки архива.`);
      yield rows[0].photo_bytes;
    })());
  }
  return layout;
}
