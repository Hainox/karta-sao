// Архив фото оцифровок кабинета приёмки: папка района → папка объекта → снимки.
//
// Иерархия та же, что у архива ТПУ и парковок: район → объект → «координаты_N».
// Объект — точка съёмки: подпись и её номер в наборе (ID площадки, номер точки
// тротуара), поэтому одноимённые адреса не слипаются в одну папку. Имя файла —
// координаты точки и номер кадра: по архиву видно, что снято и где, не открывая
// таблиц.
//
// Кадры лежат в базе, а не в медиатоме, и читаются строго по одному во время
// упаковки: гигабайты не держим в памяти. В архив идут действующие кадры
// (на проверке и принятые); отклонённые остаются в истории приёмки. Раскладка —
// чистая функция, её проверяют тесты; маршруты только собирают выборку и ставят
// задачу в общую очередь архива.

import {
  archiveDir, photoArchiveJob, prunePhotoArchiveFiles, safeSegment, startPhotoArchiveJob,
} from '../photos-archive.js';
import { DISTRICTS } from './validation.js';

const AVD_DISTRICT = 'АВД САО';
const FALLBACK_DISTRICT = 'Без района';
const FALLBACK_OBJECT = 'Объект';

/** Расширение по имени загруженного файла: сервер его уже проверил при загрузке. */
export function archivePhotoExtension(row) {
  const name = String(row?.photo_filename || '').toLowerCase();
  return name.endsWith('.png') ? 'png' : name.endsWith('.webp') ? 'webp' : 'jpg';
}

/** Координаты точки в имени файла: «55.790100, 37.560100». */
export function archiveCoordinates(row) {
  const latitude = Number(row?.latitude);
  const longitude = Number(row?.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude || longitude)
    ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
    : 'без координат';
}

/** Папка объекта: подпись и номер — у разных точек бывают одинаковые адреса. */
export function archiveObjectFolder(row) {
  const label = safeSegment(row?.label, FALLBACK_OBJECT, 90);
  const id = row?.object_id != null && String(row.object_id).trim()
    ? String(row.object_id)
    : String(row?.point_id || '').slice(0, 8);
  return safeSegment(id ? `${label} (${id})` : label, FALLBACK_OBJECT, 110);
}

/** Имя кадра: координаты точки и номер «_N». */
export function archivePhotoName(row, index = 1) {
  return `${archiveCoordinates(row)}_${index}.${archivePhotoExtension(row)}`;
}

/**
 * Раскладка архива: строки очереди кабинета (по одной на точку, с активным
 * photo_id) превращаются в файлы и список папок. Строки без кадра пропускаются:
 * «нет фото» — это не ошибка архива.
 */
export function districtArchiveLayout(rows) {
  const byPoint = new Map();
  for (const row of rows || []) {
    if (!row?.photo_id) continue;
    const key = String(row.point_id || row.object_id || '');
    if (!key) continue;
    if (!byPoint.has(key)) byPoint.set(key, []);
    byPoint.get(key).push(row);
  }
  const entries = [];
  const folders = new Set();
  for (const own of byPoint.values()) {
    const first = own[0];
    const district = safeSegment(first.district, FALLBACK_DISTRICT);
    const folder = `${district}/${archiveObjectFolder(first)}`;
    folders.add(district);
    folders.add(folder);
    own.sort((left, right) => new Date(left.uploaded_at || 0) - new Date(right.uploaded_at || 0)
      || String(left.photo_id).localeCompare(String(right.photo_id)));
    own.forEach((row, index) => {
      entries.push({
        path: `${folder}/${archivePhotoName(row, index + 1)}`,
        district: row.district || null,
        objectKey: String(row.point_id || row.object_id || ''),
        label: row.label || null,
        latitude: Number.isFinite(Number(row.latitude)) ? Number(row.latitude) : null,
        longitude: Number.isFinite(Number(row.longitude)) ? Number(row.longitude) : null,
        photoId: row.photo_id,
        pointId: row.point_id || null,
        status: row.photo_status || null,
        uploadedAt: row.uploaded_at instanceof Date ? row.uploaded_at.toISOString() : row.uploaded_at || null,
      });
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'ru', { numeric: true }));
  return { entries, folders: [...folders].sort((left, right) => left.localeCompare(right, 'ru')) };
}

/**
 * Маршруты архива для одного раздела кабинета. loadRows отдаёт строки очереди
 * (как у свода), loadPhoto читает байты кадра по entry.photoId и entry.pointId.
 * Сборка идёт в фоне, поэтому кнопка не ждёт гигабайты в ответе.
 */
export function mountDistrictPhotoArchive(router, { prefecture, prefix, loadRows, loadPhoto, allowAvd = false, pathPrefix = '' }) {
  const allowed = new Set(allowAvd ? [...DISTRICTS, AVD_DISTRICT] : DISTRICTS);
  const districtFrom = (req) => {
    const value = typeof req.query?.district === 'string' ? req.query.district.trim() : '';
    return value && allowed.has(value) ? value : '';
  };
  router.post(pathPrefix + '/photos.zip/prepare', prefecture, async (req, res, next) => {
    try {
      const district = districtFrom(req);
      const rows = (await loadRows(req)).filter((row) => row.photo_id && (!district || row.district === district));
      if (!rows.length) return res.status(409).json({ error: 'Нет фотографий для архива.' });
      const { entries, folders } = districtArchiveLayout(rows);
      for (const entry of entries) entry.read = () => loadPhoto(entry);
      // Старые архивы убираем до сборки: иначе диск заполнится гигабайтами.
      await prunePhotoArchiveFiles(archiveDir(process.env), 2, prefix);
      const job = startPhotoArchiveJob({
        rows: [], entries, folders, district: district || null, dir: archiveDir(process.env), prefix,
      });
      res.status(202).json({ id: job.id, status: job.status, total: entries.length });
    } catch (error) { next(error); }
  });
  router.get(pathPrefix + '/photos.zip/prepare/:id', prefecture, (req, res) => {
    const job = photoArchiveJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Сборка архива не найдена — запустите её заново.' });
    res.set('Cache-Control', 'private, no-store').json({
      id: job.id, status: job.status, photos: job.photos, total: job.total, bytes: job.bytes,
      skipped: job.skipped, name: job.name, error: job.error, startedAt: job.startedAt,
      finishedAt: job.finishedAt, ticket: job.status === 'ready' ? job.ticket : null,
    });
  });
}
