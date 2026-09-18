// Выгрузка фотографий архивом: папка района → папка вида → снимки.
//
// Имя файла — объект и его координаты: по архиву видно, что снято и где, не
// открывая таблиц. У одного объекта бывает несколько кадров, поэтому повтор
// получает номер в скобках, иначе второй снимок затёр бы первый.
//
// Модуль разделён надвое: раскладка, имена файлов и опись — чистые функции, их
// проверяют тесты; сборка файла и очередь задач работают с диском и потоками.

import { access, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import archiver from 'archiver';
import { mediaPath, mediaRoot, readMedia } from './storage.js';

export const ARCHIVE_VERSION = 'sao_photo_archive_v1';

// Имя готового файла: дата и случайный хвост. Проверка нужна не только при
// создании, но и при выдаче — по ней отсекаются любые чужие имена в каталоге.
export const ARCHIVE_FILE_PATTERN = /^sao-photo-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.zip$/;

// Больше двух готовых архивов на диске не держим: каждый весит гигабайты.
const ARCHIVE_KEEP = 2;
// Столько задач сборки держим в памяти, чтобы карта не росла бесконечно.
const JOBS_KEPT = 8;

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

/** Каталог готовых архивов: внутри медиатома, потому что корень контейнера только для чтения. */
export function archiveDir(environment = process.env) {
  return environment.PHOTO_SERVICE_EXPORT_DIR || join(mediaRoot(environment), 'exports');
}

/** Имя файла архива: дата и короткий случайный хвост, чтобы ссылки не угадывались. */
export function archiveName(exportedAt = new Date().toISOString()) {
  return `sao-photo-${String(exportedAt).slice(0, 10)}-${randomUUID().slice(0, 8)}.zip`;
}

/**
 * Собирает архив в файл и возвращает его описание.
 *
 * Потоком в ответ двухгигабайтный архив отдавать нельзя: браузер держит ответ в
 * памяти и падает. Поэтому файл ложится на диск, а клиент скачивает его обычной
 * ссылкой — с размером, прогрессом и возможностью докачать.
 *
 * Отклонённые приёмкой кадры в выборку не попадают: их отсекает запрос отчёта,
 * поэтому архив и таблицы показывают одни и те же фотографии.
 */
export async function writePhotoArchive(rows, options = {}) {
  const { root = mediaRoot(), dir = archiveDir(), district = null, exportedAt, onProgress } = options;
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
  const name = archiveName(exportedAt || manifest.exported_at);
  await mkdir(dir, { recursive: true });
  const target = join(dir, name);
  const output = createWriteStream(target, { flags: 'wx' });
  const archive = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });

  archive.pipe(output);
  // Ход сборки берём у самого архиватора: он считает уже обработанные записи и
  // записанные байты. Своя очередь не годится — она наполняется одним махом, и
  // «упаковано 6270 из 6270» висело бы всё время сборки. Опись и папки идут
  // первыми, поэтому из счётчика записей их вычитаем: снаружи речь о снимках.
  const leading = 1 + manifest.folders.length;
  if (onProgress) {
    archive.on('progress', (progress) => onProgress({
      photos: Math.max(0, Math.min(present.length, progress.entries.processed - leading)),
      total: present.length,
      // Байты берём у выходного потока: снимки добавляются потоками, и счётчик
      // архиватора по файлам их не видит.
      bytes: output.bytesWritten
    }));
    // Первый отчёт отдаём сразу: столько снимков предстоит упаковать.
    onProgress({ photos: 0, total: present.length, bytes: 0 });
  }
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  for (const folder of manifest.folders) archive.append('', { name: `${folder}/` });
  for (const entry of present) archive.append(readMedia(entry.storageKey, root), { name: entry.path });
  await archive.finalize();
  await done;

  // Итоговый отчёт о ходе: архиватор шлёт событие «progress» раньше, чем поток
  // сбросит байты, поэтому последний отчёт мог показать ноль записанного.
  if (onProgress) onProgress({ photos: present.length, total: present.length, bytes: output.bytesWritten });

  const { size } = await stat(target);
  return { name, bytes: size, photos: present.length, total: present.length, skipped: skipped.length };
}

/** Убирает старые готовые архивы: держим только последние. Диск на сервере не бесконечен. */
export async function prunePhotoArchiveFiles(dir = archiveDir(), keep = ARCHIVE_KEEP) {
  try {
    const names = (await readdir(dir)).filter((name) => ARCHIVE_FILE_PATTERN.test(name));
    const dated = await Promise.all(names.map(async (name) => ({
      name, modified: (await stat(join(dir, name))).mtimeMs
    })));
    dated.sort((left, right) => right.modified - left.modified);
    const stale = dated.slice(keep);
    for (const { name } of stale) await unlink(join(dir, name));
    return stale.length;
  } catch {
    return 0;
  }
}

const jobs = new Map();

/**
 * Ставит сборку в фон и сразу отдаёт задачу: двухгигабайтный архив собирается
 * минутами, а запрос столько ждать не должен — его оборвёт прокси.
 *
 * Билет нужен для скачивания: файл забирает браузер обычной навигацией, и cookie
 * с чужого сайта может не дойти, а билет в ссылке работает всегда.
 */
export function startPhotoArchiveJob({ rows, ...options } = {}) {
  const id = options.id || randomUUID();
  const job = {
    id,
    ticket: randomUUID(),
    status: 'building',
    district: options.district || null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    photos: 0,
    total: 0,
    bytes: 0,
    skipped: 0,
    name: null,
    error: null
  };
  jobs.set(id, job);
  // Старые задачи держим только пока о них могут спросить.
  if (jobs.size > JOBS_KEPT) {
    const oldest = [...jobs.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0];
    jobs.delete(oldest.id);
  }

  job.done = writePhotoArchive(rows, {
    ...options,
    onProgress: (progress) => Object.assign(job, progress)
  })
    .then((result) => Object.assign(job, result, { status: 'ready', finishedAt: new Date().toISOString() }))
    .catch((error) => Object.assign(job, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() }));
  return job;
}

export function photoArchiveJob(id) {
  return jobs.get(id) || null;
}

/** Готовый архив по билету: билет выдаётся вместе с задачей сборки. */
export function photoArchiveByTicket(ticket) {
  if (!ticket) return null;
  for (const job of jobs.values()) {
    if (job.ticket === ticket && job.status === 'ready' && job.name) return job;
  }
  return null;
}
