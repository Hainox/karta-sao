import { createDirectionRepository, mountPublicDirectionRoutes, mountDirectionRoutes } from './direction-corrections.js';
import { DISTRICT_DATASET, IMPORTED_NOTE_PREFIX, PREFECTURE_ARCHIVE_CUTOFF, PREFECTURE_ARCHIVE_CUTOFF_MS, createDistrictPointPhotoRepository, mountDistrictPointPhotoRoutes } from './district-point-photos.js';
import { AVD_OWNER, AVD_OBJECTS, AVD_OUTSIDE_OBJECT, AVD_OUTSIDE_BOUNDARY } from './tpu-responsibility.js';
import crypto from 'node:crypto';
import express from 'express';
import { readFileSync } from 'node:fs';
import { DISTRICTS, isPointWithinBoundary } from './validation.js';
import { pointInRing } from '../districts.js';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';
import { objectsWithSlotCounts, createSlotRepository, mountPublicSlotRoutes, mountSlotRoutes } from './object-slots.js';

const ROLES = new Set(['prefecture_admin', 'reviewer', 'district_editor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Статусы фото появляются с миграции 017: ракурс-marker приёмки — у районных
// точек («одно живое фото на точку»), у ТПУ старые вложения остаются принятыми.
const PHOTO_COLUMNS = 'id, point_id, assignment_version, assignment_longitude, assignment_latitude, photo_mime_type, photo_filename, photo_size, uploaded_by, uploaded_at, status, review_comment, reviewed_by, reviewed_at, dataset_id';
const isImportedDistrictPoint = (point) => point?.dataset_id === DISTRICT_DATASET
  && typeof point?.note === 'string' && point.note.startsWith(IMPORTED_NOTE_PREFIX);

// Наборы точек съёмки. Районные точки («эталонные фото») — второй набор: точки
// закреплены за конкретным районом; ставит и правит их только префектура.
// Приёмки точек нет: каждая точка сразу принята и имеет открытый фотослот,
// район только загружает фото в свои точки.
const DATASETS = {
  sao_tpu_parking: { objectTypes: ['tpu', 'parking'], allowAvd: true },
  sao_district_photo_points: { objectTypes: ['district'], allowAvd: false },
};

// Полигоны 16 районов (WGS84) — та же выгрузка, что и в districts.geojson атласа.
// Границы OSM-происхождения, поэтому допуск в метрах для пограничных точек.
const DISTRICT_TOLERANCE_M = 250;
const DISTRICT_FEATURES = JSON.parse(readFileSync(new URL('./districts_wgs84.geojson', import.meta.url), 'utf8')).features;

/** Точка внутри полигона района (с вычетом дыр). */
function pointInsideDistrict(longitude, latitude, district) {
  for (const feature of DISTRICT_FEATURES) {
    if (feature?.properties?.district !== district) continue;
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      if (pointInRing([longitude, latitude], polygon[0])
        && polygon.slice(1).every((hole) => !pointInRing([longitude, latitude], hole))) return true;
    }
  }
  return false;
}

/** Расстояние от точки до полигона района в метрах (0 — точка на границе). */
function distanceToDistrictMeters(longitude, latitude, district) {
  let best = Infinity;
  const mX = 111320 * Math.cos(latitude * Math.PI / 180);
  const mY = 110540;
  for (const feature of DISTRICT_FEATURES) {
    if (feature?.properties?.district !== district) continue;
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[j];
          const dx = (x2 - x1) * mX;
          const dy = (y2 - y1) * mY;
          const px = (longitude - x1) * mX;
          const py = (latitude - y1) * mY;
          const lengthSquared = dx * dx + dy * dy || 1e-9;
          const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
          const d = Math.hypot(px - t * dx, py - t * dy);
          if (d < best) best = d;
        }
      }
    }
  }
  return best;
}

export function validateObjectPhotoPoint(input, boundary) {
  const errors = [];
  const dataset = DATASETS[input?.datasetId];
  if (!dataset) errors.push('Неизвестный набор объектов.');
  if (typeof input?.objectKey !== 'string' || !input.objectKey.trim() || input.objectKey.length > 180) errors.push('Укажите идентификатор объекта.');
  if (!dataset?.objectTypes.includes(input?.objectType)) errors.push('Укажите тип объекта.');
  else if (typeof input?.objectKey === 'string' && !input.objectKey.startsWith(input.objectType + ':')) errors.push('Тип объекта не совпадает с идентификатором.');
  if (!DISTRICTS.has(input?.district) && !(dataset?.allowAvd && input?.district === AVD_OWNER)) errors.push('Укажите район САО.');
  if (typeof input?.longitude !== 'number' || typeof input?.latitude !== 'number' || !Number.isFinite(input.longitude) || !Number.isFinite(input.latitude) || Math.abs(input.longitude) > 180 || Math.abs(input.latitude) > 90) errors.push('Некорректные координаты.');
  else if (!isPointWithinBoundary([input.longitude, input.latitude], boundary) && !(input.district === AVD_OWNER && input.objectKey === AVD_OUTSIDE_OBJECT && isPointWithinBoundary([input.longitude, input.latitude], AVD_OUTSIDE_BOUNDARY))) errors.push('Точка должна находиться в границах САО.');
  else if (input?.datasetId === 'sao_district_photo_points' && DISTRICTS.has(input?.district)
    && !pointInsideDistrict(input.longitude, input.latitude, input.district)
    && distanceToDistrictMeters(input.longitude, input.latitude, input.district) > DISTRICT_TOLERANCE_M) {
    errors.push('Точка съёмки должна находиться в своём районе.');
  }
  if (AVD_OBJECTS.has(input?.objectKey) && input?.district !== AVD_OWNER) errors.push('Объект закреплён за АвД САО.');
  if (input?.district === AVD_OWNER && !AVD_OBJECTS.has(input?.objectKey)) errors.push('Объект не относится к АвД САО.');
  if (typeof input?.label !== 'string' || !input.label.trim() || input.label.length > 160) errors.push('Название точки должно содержать от 1 до 160 символов.');
  if (input?.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) errors.push('Описание должно быть строкой до 2000 символов.');
  if (input?.heading != null && (typeof input.heading !== 'number' || !Number.isFinite(input.heading) || input.heading < 0 || input.heading >= 360)) errors.push('Направление должно быть числом от 0 до 360 градусов.');
  return { valid: errors.length === 0, errors, value: errors.length ? null : { ...input, heading: input.heading ?? null, objectKey: input.objectKey.trim(), label: input.label.trim(), note: input.note?.trim() || '' } };
}

export function createObjectPhotoPointsRouter({ repository, authenticate, boundary }) {
  const router = express.Router();
  router.get('/public', async (req, res, next) => {
    try {
      const dataset = req.query.dataset === 'sao_district_photo_points' ? 'sao_district_photo_points' : 'sao_tpu_parking';
      // Публично видны только принятые префектурой точки: ожидающие приёмки
      // (их ставит район) и архив до 23.10.2026 11:00 в открытые списки не идут.
      // Импортные точки (NextGIS/GPKG) публичный список тоже не отдаёт.
      const points = await repository.listObjectPhotoPoints({
        datasetId: dataset,
        district: req.query.district || null,
        acceptedOnly: dataset === 'sao_district_photo_points',
        excludePrefectureArchive: dataset === 'sao_district_photo_points',
        excludeImported: dataset === 'sao_district_photo_points',
      });
      res.setHeader('Cache-Control', 'no-store');
      // У районных точек открытым остаётся и состояние слота (без комментария
      // префектуры): карты окрашивают точки, кабинет не открывает себя лишний раз.
      res.json({ points: points.map((point) => {
        const { id, object_key, object_type, district, longitude, latitude, label, heading, photo_count, photo_state, note } = point;
        // Признак «точка перенесена из GeoPackage» — без раскрытия текста примечания.
        const imported = dataset === 'sao_district_photo_points' && typeof note === 'string' && note.startsWith(IMPORTED_NOTE_PREFIX);
        return { id, object_key, object_type, district, longitude, latitude, label, heading, photo_count, ...(photo_state ? { photo_state } : {}), ...(imported ? { imported: true } : {}) };
      }) });
    } catch (error) { next(error); }
  });
  mountPublicSlotRoutes(router, { repository });
  mountPublicDirectionRoutes(router, { repository });
  router.use(authenticate, (req, res, next) => {
    if (!ROLES.has(req.user.role) || (req.user.role === 'district_editor' && !req.user.district)) return res.status(403).json({ error: 'Нет доступа к точкам фотофиксации.' });
    next();
  });
  const prefecture = (req, res, next) => req.user.role === 'prefecture_admin' ? next() : res.status(403).json({ error: 'Точки назначает только префектура.' });
  const districtFor = (req) => req.user.role === 'district_editor' ? req.user.district : undefined;
  // Слоты фото по заданию, направления и приёмка районных точек — до «/:id» съёмки.
  mountSlotRoutes(router, { repository, districtFor });
  mountDirectionRoutes(router, { repository });
  mountDistrictPointPhotoRoutes(router, { repository, districtFor });
  router.param('id', (req, res, next, id) => UUID.test(id) ? next() : res.status(400).json({ error: 'Некорректный идентификатор точки.' }));
  router.param('photoId', (req, res, next, id) => UUID.test(id) ? next() : res.status(400).json({ error: 'Некорректный идентификатор фото.' }));
  router.get('/prefecture-archive', prefecture, async (req, res, next) => {
    try {
      const district = typeof req.query.district === 'string' ? req.query.district : null;
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ points: await repository.listPrefectureArchivePoints({ district }) });
    } catch (error) { next(error); }
  });
  router.get('/report.xlsx', (req, res, next) => req.user.role === 'prefecture_admin' ? next() : res.status(403).json({ error: 'Сводка доступна только префектуре.' }), async (req, res, next) => {
    try {
      if (req.query.dataset === 'sao_district_photo_points') {
        // Две сводки: ?report=points — статусы приёмки точек, ?report=photos — загруженные снимки.
        if (req.query.report === 'photos') {
          const [{ summarizeDistrictPhotos, buildDistrictPhotosReport }, data] = await Promise.all([
            import('./district-photo-report.js'),
            repository.tpuReportData({ datasetId: 'sao_district_photo_points', kind: null }),
          ]);
          const generatedAt = new Date();
          const book = await buildDistrictPhotosReport(summarizeDistrictPhotos({ ...data, generatedAt }));
          const day = generatedAt.toISOString().slice(0, 10);
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('Content-Disposition', `attachment; filename="Svodka_Foto_Rayonov_SAO_${day}.xlsx"`);
          res.setHeader('Cache-Control', 'no-store');
          res.send(book);
          return;
        }
        const [{ summarizeDistrictPoints, buildDistrictPointsReport, REPORT_KINDS_DISTRICT }, data] = await Promise.all([
          import('./district-points-report.js'),
          repository.tpuReportData({ datasetId: 'sao_district_photo_points', kind: null }),
        ]);
        const generatedAt = new Date();
        const book = await buildDistrictPointsReport(summarizeDistrictPoints({ ...data, generatedAt }));
        const day = generatedAt.toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${REPORT_KINDS_DISTRICT.district.file}_${day}.xlsx"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(book);
        return;
      }
      // Сводки по ТПУ и по парковкам выгружаются отдельными файлами: ?kind=tpu (по умолчанию) или ?kind=parking.
      const kind = req.query.kind || 'tpu';
      if (!['tpu', 'parking'].includes(kind)) return res.status(400).json({ error: 'Неизвестный вид сводки.' });
      const [{ summarizeTpu, buildTpuReport, REPORT_KINDS }, data] = await Promise.all([import('./tpu-report.js'), repository.tpuReportData({ datasetId: 'sao_tpu_parking', kind })]);
      const generatedAt = new Date();
      const book = await buildTpuReport(summarizeTpu({ ...data, objects: [...objectsWithSlotCounts(await repository.listSlotCounts()).values()], kind, generatedAt }));
      const day = generatedAt.toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${REPORT_KINDS[kind].file}_${day}.xlsx"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(book);
    } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try {
      if (req.query.dataset && !DATASETS[req.query.dataset]) return res.status(400).json({ error: 'Неизвестный набор объектов.' });
      const datasetId = req.query.dataset || 'sao_tpu_parking';
      const points = await repository.listObjectPhotoPoints({ datasetId, objectKey: req.query.objectKey, district: districtFor(req) || req.query.district, acceptedOnly: req.user.role === 'district_editor' && datasetId === 'sao_district_photo_points', excludePrefectureArchive: datasetId === 'sao_district_photo_points', excludeImported: datasetId === 'sao_district_photo_points' && req.user.role === 'district_editor' });
      res.json({ points });
    } catch (error) { next(error); }
  });
  router.post('/', prefecture, async (req, res, next) => {
    try {
      const validation = validateObjectPhotoPoint(req.body, boundary);
      if (!validation.valid) return res.status(422).json({ error: 'Точка не прошла проверку.', details: validation.errors });
      // Приёмки точек нет: точка сразу принята и имеет открытый фотослот.
      res.status(201).json({ point: await repository.createObjectPhotoPoint({ ...validation.value, reviewStatus: 'accepted', actorId: req.user.sub }) });
    } catch (error) { next(error); }
  });
  router.patch('/:id', prefecture, async (req, res, next) => {
    try {
      const existing = await repository.getObjectPhotoPoint({ id: req.params.id });
      if (!existing) return res.status(404).json({ error: 'Точка не найдена.' });
      const editable = ['longitude', 'latitude', 'label', 'note', 'heading'];
      if (!req.body || Object.keys(req.body).some((key) => !editable.includes(key))) return res.status(400).json({ error: 'Можно изменить координаты, направление, название и описание точки.' });
      const validation = validateObjectPhotoPoint({ datasetId: existing.dataset_id, objectKey: existing.object_key, objectType: existing.object_type, district: existing.district, longitude: existing.longitude, latitude: existing.latitude, label: existing.label, note: existing.note, heading: existing.heading ?? null, ...req.body }, boundary);
      if (!validation.valid) return res.status(422).json({ error: 'Точка не прошла проверку.', details: validation.errors });
      const point = await repository.updateObjectPhotoPoint({ id: req.params.id, ...validation.value, actorId: req.user.sub, keepAssignmentVersion: existing.dataset_id === DISTRICT_DATASET });
      if (!point) return res.status(404).json({ error: 'Точка не найдена.' });
      res.json({ point });
    } catch (error) { next(error); }
  });
  router.delete('/:id', prefecture, async (req, res, next) => {
    try {
      const point = await repository.retireObjectPhotoPoint({ id: req.params.id, actorId: req.user.sub });
      if (!point) return res.status(404).json({ error: 'Точка не найдена.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  const accessPoint = async (req, res, next) => {
    try {
      req.photoPoint = await repository.getObjectPhotoPoint({ id: req.params.id, district: districtFor(req) });
      if (!req.photoPoint) return res.status(404).json({ error: 'Точка не найдена.' });
      if (req.user.role !== 'prefecture_admin' && req.photoPoint.dataset_id === 'sao_district_photo_points'
        && (new Date(req.photoPoint.created_at).getTime() < PREFECTURE_ARCHIVE_CUTOFF_MS || isImportedDistrictPoint(req.photoPoint))) {
        return res.status(404).json({ error: 'Точка не найдена.' });
      }
      next();
    } catch (error) { next(error); }
  };
  router.get('/:id/photos', accessPoint, async (req, res, next) => {
    try { res.json({ photos: await repository.listObjectPhotoPointPhotos(req.params.id) }); } catch (error) { next(error); }
  });
  router.put('/:id/photos', (req, res, next) => req.user.role !== 'reviewer' ? next() : res.status(403).json({ error: 'Фото загружает район или префектура.' }), accessPoint, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), async (req, res, next) => {
    try {
      const expectedVersion = Number(req.get('x-assignment-version'));
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return res.status(400).json({ error: 'Укажите версию точки съёмки.' });
      const validation = validatePhotoUpload(req.body, req.get('content-type'));
      if (!validation.valid) return res.status(422).json({ error: validation.error });
      const photo = await repository.addObjectPhotoPointPhoto({ pointId: req.params.id, district: districtFor(req), expectedVersion, bytes: req.body, mimeType: validation.mimeType, filename: safePhotoFilename(req.get('x-photo-filename')), actorId: req.user.sub });
      if (!photo) return res.status(404).json({ error: 'Точка не найдена.' });
      res.status(201).json({ photo });
    } catch (error) { next(error); }
  });
  router.get('/:id/photos/:photoId', accessPoint, async (req, res, next) => {
    try {
      const photo = await repository.getObjectPhotoPointPhoto({ pointId: req.params.id, photoId: req.params.photoId });
      if (!photo) return res.status(404).json({ error: 'Фото не найдено.' });
      res.setHeader('Cache-Control', 'private, no-store');
      res.type(photo.photo_mime_type).send(photo.photo_bytes);
    } catch (error) { next(error); }
  });
  // Удаление одного кадра оставляет точку съёмки и её направление (стрелку) на месте:
  // объект снова становится «без фото», но задание для района не пропадает.
  router.delete('/:id/photos/:photoId', prefecture, accessPoint, async (req, res, next) => {
    try {
      const photo = await repository.deleteObjectPhotoPointPhoto({ pointId: req.params.id, photoId: req.params.photoId, actorId: req.user.sub });
      if (!photo) return res.status(404).json({ error: 'Фото не найдено.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}

export function createObjectPhotoPointRepository(pool, { writeAudit } = {}) {
  const write = async (actorId, eventType, details, operation) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      if (result) {
        const metadata = { ...details, id: result.id };
        if (writeAudit) await writeAudit(client, { actorId, eventType, metadata });
        else await client.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [crypto.randomUUID(), actorId, eventType, JSON.stringify(metadata)]);
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
      throw error;
    } finally { client.release(); }
  };
  return {
    ...createSlotRepository(pool, write),
    ...createDirectionRepository(pool, write),
    ...createDistrictPointPhotoRepository(pool, write),
    async listObjectPhotoPoints({ datasetId, objectKey, district, acceptedOnly = false, excludePrefectureArchive = false, excludeImported = false }) {
      // Районный набор: рядом со счётчиком живёт состояние слота точки —
      // «Нет фото / На проверке / Принято / На доработке» без комментария.
      if (datasetId === DISTRICT_DATASET) {
        const { rows } = await pool.query(`
          SELECT p.*,
            (SELECT count(*)::integer FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.assignment_version = p.assignment_version) AS photo_count,
            CASE
              WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'pending' AND f.dataset_id = 'sao_district_photo_points') THEN 'pending'
              WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'accepted' AND f.dataset_id = 'sao_district_photo_points') THEN 'accepted'
              WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'rejected' AND f.dataset_id = 'sao_district_photo_points') THEN 'rework'
              ELSE 'empty'
            END AS photo_state
          FROM object_photo_points p
          WHERE retired_at IS NULL AND dataset_id = $1 AND ($2::text IS NULL OR object_key = $2) AND ($3::text IS NULL OR district = $3)
            AND (NOT $4::boolean OR review_status = 'accepted')
            AND (NOT $5::boolean OR created_at >= ${PREFECTURE_ARCHIVE_CUTOFF})
            AND (NOT $6::boolean OR COALESCE(note, '') NOT LIKE 'Источник:%')
          ORDER BY created_at, id`, [datasetId, objectKey || null, district || null, acceptedOnly, excludePrefectureArchive, excludeImported]);
        return rows;
      }
      const { rows } = await pool.query('SELECT p.*, (SELECT count(*)::integer FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.assignment_version = p.assignment_version) AS photo_count FROM object_photo_points p WHERE retired_at IS NULL AND dataset_id = $1 AND ($2::text IS NULL OR object_key = $2) AND ($3::text IS NULL OR district = $3) ORDER BY created_at, id', [datasetId, objectKey || null, district || null]);
      return rows;
    },
    async listPrefectureArchivePoints({ district }) {
      const { rows } = await pool.query(`
        SELECT p.*,
          (SELECT count(*)::integer FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.assignment_version = p.assignment_version) AS photo_count,
          CASE
            WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'pending' AND f.dataset_id = 'sao_district_photo_points') THEN 'pending'
            WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'accepted' AND f.dataset_id = 'sao_district_photo_points') THEN 'accepted'
            WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'rejected' AND f.dataset_id = 'sao_district_photo_points') THEN 'rework'
            ELSE 'empty'
          END AS photo_state
        FROM object_photo_points p
        WHERE p.dataset_id = 'sao_district_photo_points' AND p.retired_at IS NULL
          AND p.created_at < ${PREFECTURE_ARCHIVE_CUTOFF}
          AND ($1::text IS NULL OR p.district = $1)
        ORDER BY p.created_at, p.district, p.label`, [district || null]);
      return rows;
    },
    async tpuReportData({ datasetId, kind = null }) {
      const points = await pool.query('SELECT p.id, p.object_key, p.object_type, p.district, p.label, p.note, p.longitude, p.latitude, p.heading, p.created_at, p.review_status, p.review_comment, p.reviewed_at, (SELECT count(*)::integer FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.assignment_version = p.assignment_version) AS photo_count, (SELECT max(f.uploaded_at) FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.assignment_version = p.assignment_version) AS last_photo_at FROM object_photo_points p WHERE p.retired_at IS NULL AND p.dataset_id = $1 AND ($2::text IS NULL OR p.object_type = $2) ORDER BY p.created_at, p.id', [datasetId, kind]);
      const daily = await pool.query("SELECT to_char(f.uploaded_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day, count(*)::integer AS photos, count(DISTINCT f.point_id)::integer AS points FROM object_photo_point_photos f JOIN object_photo_points p ON p.id = f.point_id WHERE p.dataset_id = $1 AND p.retired_at IS NULL AND ($2::text IS NULL OR p.object_type = $2) AND f.uploaded_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1", [datasetId, kind]);
      // Фото по слотам задания (без самих снимков) — для колонок проверки в сводке.
      const slots = datasetId === 'sao_tpu_parking'
        ? await pool.query("SELECT object_key, slot, status, review_comment, uploaded_at, reviewed_at FROM object_slot_photos WHERE dataset_id = $1 AND ($2::text IS NULL OR object_key LIKE $2 || ':%')", [datasetId, kind])
        : { rows: [] };
      return { points: points.rows, slots: slots.rows, daily: daily.rows };
    },
    async getObjectPhotoPoint({ id, district }) {
      const { rows } = await pool.query('SELECT * FROM object_photo_points WHERE id = $1 AND retired_at IS NULL AND ($2::text IS NULL OR district = $2)', [id, district || null]);
      return rows[0] || null;
    },
    createObjectPhotoPoint({ datasetId, objectKey, objectType, district, longitude, latitude, label, note, actorId, heading = null, reviewStatus = 'accepted' }) {
      return write(actorId, 'object_photo_point_created', { datasetId, objectKey }, async (client) => {
        const { rows } = await client.query('INSERT INTO object_photo_points (id, dataset_id, object_key, object_type, district, longitude, latitude, label, note, created_by, updated_by, heading, review_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12) RETURNING *', [crypto.randomUUID(), datasetId, objectKey, objectType, district, longitude, latitude, label, note, actorId, heading, reviewStatus]);
        return rows[0];
      });
    },
    updateObjectPhotoPoint({ id, longitude, latitude, label, note, actorId, heading = null, keepAssignmentVersion = false, reviewStatus = null }) {
      return write(actorId, 'object_photo_point_updated', { pointId: id }, async (client) => {
        // У районных точек перенос и смена направления не перетирают фото:
        // слот живёт своей жизнью («Принято» сохраняется). У ТПУ остаётся
        // прежняя привязка снимков к версии ракурса: версия растёт только
        // когда изменилась привязка или направление.
        const { rows } = await client.query(`UPDATE object_photo_points SET assignment_version = assignment_version + CASE WHEN NOT $8::boolean AND (longitude IS DISTINCT FROM $2 OR latitude IS DISTINCT FROM $3 OR heading IS DISTINCT FROM $7) THEN 1 ELSE 0 END, longitude = $2, latitude = $3, label = $4, note = $5, updated_by = $6, heading = $7, review_status = COALESCE($9, review_status), review_comment = CASE WHEN $9 = 'pending' THEN '' ELSE review_comment END, reviewed_by = CASE WHEN $9 = 'pending' THEN NULL ELSE reviewed_by END, reviewed_at = CASE WHEN $9 = 'pending' THEN NULL ELSE reviewed_at END, updated_at = now() WHERE id = $1 AND retired_at IS NULL RETURNING *`, [id, longitude, latitude, label, note, actorId, heading, keepAssignmentVersion, reviewStatus]);
        return rows[0] || null;
      });
    },
    retireObjectPhotoPoint({ id, actorId }) {
      return write(actorId, 'object_photo_point_retired', { pointId: id }, async (client) => {
        const { rows } = await client.query('UPDATE object_photo_points SET retired_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 AND retired_at IS NULL RETURNING *', [id, actorId]);
        return rows[0] || null;
      });
    },
    async listObjectPhotoPointPhotos(pointId) {
      const { rows } = await pool.query(`SELECT ${PHOTO_COLUMNS} FROM object_photo_point_photos WHERE point_id = $1 ORDER BY uploaded_at, id`, [pointId]);
      return rows;
    },
    addObjectPhotoPointPhoto({ pointId, district, bytes, mimeType, filename, actorId, expectedVersion }) {
      return write(actorId, 'object_photo_point_photo_uploaded', { pointId }, async (client) => {
        // Lock the assignment so retirement cannot race with a district upload.
        const point = await client.query('SELECT id, assignment_version, longitude, latitude, dataset_id FROM object_photo_points WHERE id = $1 AND retired_at IS NULL AND ($2::text IS NULL OR district = $2) FOR UPDATE', [pointId, district || null]);
        if (!point.rows[0]) return null;
        const assignment = point.rows[0];
        if (expectedVersion !== assignment.assignment_version) throw Object.assign(new Error('Точка изменена префектурой. Обновите карточку и выберите текущий ракурс.'), { status: 409 });
        // Районная точка — один слот: в нём уже действует фото (на проверке
        // или принятое), новое не принимаем; отклонение открывает слот заново.
        if (assignment.dataset_id === DISTRICT_DATASET) {
          const active = await client.query(`SELECT 1 FROM object_photo_point_photos WHERE point_id = $1 AND status IN ('pending', 'accepted') LIMIT 1`, [pointId]);
          if (active.rows.length) throw Object.assign(new Error('В слоте точки уже есть фото: на проверке или принятое. Заменить его может префектура, а после отклонения фото загружается заново.'), { status: 409 });
        }
        const { rows } = await client.query(`INSERT INTO object_photo_point_photos (id, point_id, photo_bytes, photo_mime_type, photo_filename, photo_size, uploaded_by, assignment_version, assignment_longitude, assignment_latitude, status, dataset_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${PHOTO_COLUMNS}`, [crypto.randomUUID(), pointId, bytes, mimeType, filename, bytes.length, actorId, assignment.assignment_version, assignment.longitude, assignment.latitude, assignment.dataset_id === DISTRICT_DATASET ? 'pending' : 'accepted', assignment.dataset_id]);
        return rows[0];
      });
    },
    async getObjectPhotoPointPhoto({ pointId, photoId }) {
      const { rows } = await pool.query('SELECT photo_bytes, photo_mime_type, photo_filename FROM object_photo_point_photos WHERE id = $1 AND point_id = $2', [photoId, pointId]);
      return rows[0] || null;
    },
    deleteObjectPhotoPointPhoto({ pointId, photoId, actorId }) {
      return write(actorId, 'object_photo_point_photo_deleted', { pointId }, async (client) => {
        const { rows } = await client.query('DELETE FROM object_photo_point_photos WHERE id = $1 AND point_id = $2 RETURNING id', [photoId, pointId]);
        return rows[0] || null;
      });
    }
  };
}
