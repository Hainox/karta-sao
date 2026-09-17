// Выгрузка фотографий архивом: папка района → папка вида → снимки.
//
// Имя файла — объект и его координаты: по архиву видно, что снято и где, не
// открывая таблиц. У одного объекта бывает несколько кадров, поэтому повтор
// получает номер в скобках, иначе второй снимок затёр бы первый.
//
// Модуль разделён надвое: сборка списка файлов и имён — чистые функции, их
// проверяют тесты; отправка архива работает с потоком и с диском.

import { access } from 'node:fs/promises';
import archiver from 'archiver';
import { mediaPath, mediaRoot, readMedia } from './storage.js';

export const ARCHIVE_VERSION = 'sao_photo_archive_v1';

// Три папки видов внутри каждого района — ровно то, что заказано.
export const TYPE_FOLDERS = Object.freeze({ stop: 'Остановки', pp: 'ПП', entrance: 'Подъезды' });

const FALLBACK_DISTRICT = 'Без района';
const FALLBACK_LABEL = 'объект';
const FALLBACK_TYPE = 'Прочее';
const MAX_SEGMENT = 80;
const MAX_FILE_NAME = 120;
const EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/webp': 'webp' });

/** Сегмент пути без символов, запрещённых в Windows, macOS и внутри zip. */
export function safeSegment(value, fallback = FALLBACK_DISTRICT, limit = MAX_SEGMENT) {
  const cleaned = String(value === null || value === undefined ? '' : value)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, limit)
    .trim();
  return cleaned || fallback;
}

/**
 * Координаты объекта — первая точка привязки. Если её нет, берём координаты
 * самого кадра; если и их нет, файл уходит с пометкой «без координат».
 */
export function coordinatesOf(row, photo) {
  const points = Array.isArray(row && row.reference_points) ? row.reference_points : [];
  for (const point of points) {
    const latitude = Number(point && point.latitude);
    const longitude = Number(point && point.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude };
  }
  const latitude = Number(photo && photo.gpsLatitude);
  const longitude = Number(photo && photo.gpsLongitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

/** Имя файла: «имя объекта координаты»; у повторов — «(2)» перед расширением. */
export function photoFileName(row, photo, index = 1) {
  const coordinates = coordinatesOf(row, photo);
  const suffix = coordinates
    ? ` ${coordinates.latitude.toFixed(5)}, ${coordinates.longitude.toFixed(5)}`
    : ' без координат';
  const tail = index > 1 ? ` (${index})` : '';
  const extension = `.${EXTENSIONS[photo && photo.mimeType] || 'jpg'}`;
  const room = Math.max(16, MAX_FILE_NAME - suffix.length - tail.length - extension.length);
  const label = safeSegment(row && row.label, FALLBACK_LABEL, MAX_SEGMENT).slice(0, room).trim();
  return `${label}${suffix}${tail}${extension}`;
}

/**
 * Папки архива: район плюс все три вида, даже там, где снимков пока нет — иначе
 * по архиву нельзя понять, папка вида пуста или её забыли создать.
 */
export function archiveFolders(rows) {
  const districts = new Map();
  for (const row of rows) {
    const district = safeSegment(row && row.district, FALLBACK_DISTRICT);
    const type = TYPE_FOLDERS[row && row.object_type] || safeSegment(row && row.object_type, FALLBACK_TYPE);
    if (!districts.has(district)) districts.set(district, new Set());
    districts.get(district).add(type);
  }
  const folders = [];
  for (const [district, types] of districts) {
    for (const type of Object.values(TYPE_FOLDERS)) types.add(type);
    for (const type of [...types].sort((left, right) => left.localeCompare(right, 'ru'))) {
      folders.push(`${district}/${type}`);
    }
  }
  return folders.sort((left, right) => left.localeCompare(right, 'ru'));
}

/** Список файлов архива: путь в архиве, ключ хранилища и данные для manifest. */
export function photoArchiveEntries(rows) {
  const entries = [];
  for (const row of rows) {
    const district = safeSegment(row && row.district, FALLBACK_DISTRICT);
    const folder = TYPE_FOLDERS[row && row.object_type] || safeSegment(row && row.object_type, FALLBACK_TYPE);
    const photos = Array.isArray(row && row.photos) ? row.photos : [];
    photos.forEach((photo, index) => {
      const coordinates = coordinatesOf(row, photo);
      entries.push({
        path: `${district}/${folder}/${photoFileName(row, photo, index + 1)}`,
        storageKey: photo.storageKey,
        district: (row && row.district) || null,
        objectType: row && row.object_type,
        objectKey: row && row.object_key,
        label: row && row.label,
        latitude: coordinates ? coordinates.latitude : null,
        longitude: coordinates ? coordinates.longitude : null,
        photoId: photo.id,
        uploadedAt: photo.uploadedAt,
        performer: photo.performer,
        reviewStatus: photo.reviewStatus,
        geoStatus: photo.geoStatus,
        sha256: photo.sha256,
        byteSize: Number(photo.byteSize) || 0
      });
    });
  }
  return entries;
}

/** Опись архива: что именно лежит внутри — без неё архив нечем проверить. */
export function photoArchiveManifest(rows, files, { exportedAt = new Date().toISOString(), district = null, skipped = [] } = {}) {
  return {
    archive_version: ARCHIVE_VERSION,
    exported_at: exportedAt,
    selection: {
      district: district || 'весь САО',
      objects: rows.length,
      objects_with_photos: rows.filter((row) => Array.isArray(row.photos) && row.photos.length > 0).length,
      photos: files.length,
      skipped: skipped.length
    },
    folders: archiveFolders(rows),
    // Ключ хранилища наружу не отдаём: он нужен только сервису.
    files: files.map(({ storageKey, ...file }) => file),
    skipped
  };
}

/**
 * Собирает архив и отдаёт его потоком: держать в памяти тысячи снимков нельзя.
 * Отклонённые приёмкой кадры в выборку не попадают — их отсекает запрос отчёта,
 * поэтому архив и таблицы показывают одни и те же фотографии.
 */
export async function streamPhotoArchive(response, rows, options = {}) {
  const { root = mediaRoot(), exportedAt, district = null } = options;
  const entries = photoArchiveEntries(rows);

  const present = [];
  const skipped = [];
  for (const entry of entries) {
    // Файл могли удалить после выборки: кадр пропускаем, но архив не роняем.
    try {
      await access(mediaPath(entry.storageKey, root));
      present.push(entry);
    } catch {
      skipped.push(entry.path);
    }
  }

  const manifest = photoArchiveManifest(rows, present, { exportedAt, district, skipped });
  const archive = archiver('zip', { zlib: { level: 6 } });
  const completed = new Promise((resolve, reject) => {
    archive.once('error', reject);
    response.once('error', reject);
    response.once('finish', resolve);
  });

  archive.pipe(response);
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  for (const folder of manifest.folders) archive.append('', { name: `${folder}/` });
  for (const entry of present) archive.append(readMedia(entry.storageKey, root), { name: entry.path });

  await archive.finalize();
  await completed;
  return { photos: present.length, skipped: skipped.length };
}
