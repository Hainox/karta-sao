import { AVD_OWNER, AVD_OBJECTS } from './tpu-responsibility.js';
import crypto from 'node:crypto';
import express from 'express';
import { DISTRICTS, isPointWithinBoundary } from './validation.js';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';

const ROLES = new Set(['prefecture_admin', 'reviewer', 'district_editor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_COLUMNS = 'id, point_id, assignment_version, assignment_longitude, assignment_latitude, photo_mime_type, photo_filename, photo_size, uploaded_by, uploaded_at';

export function validateObjectPhotoPoint(input, boundary) {
  const errors = [];
  if (input?.datasetId !== 'sao_tpu_parking') errors.push('Неизвестный набор объектов.');
  if (typeof input?.objectKey !== 'string' || !input.objectKey.trim() || input.objectKey.length > 180) errors.push('Укажите идентификатор объекта.');
  if (input?.objectType !== 'tpu' || input?.objectKey?.startsWith?.('parking:')) errors.push('В задания входят только ТПУ.');
  if (!DISTRICTS.has(input?.district) && input?.district !== AVD_OWNER) errors.push('Укажите район САО.');
  if (typeof input?.longitude !== 'number' || typeof input?.latitude !== 'number' || !Number.isFinite(input.longitude) || !Number.isFinite(input.latitude) || Math.abs(input.longitude) > 180 || Math.abs(input.latitude) > 90) errors.push('Некорректные координаты.');
  else if (!isPointWithinBoundary([input.longitude, input.latitude], boundary)) errors.push('Точка должна находиться в границах САО.');
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
      const points = await repository.listObjectPhotoPoints({ datasetId: 'sao_tpu_parking' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ points: points.map(({ id, object_key, object_type, district, longitude, latitude, label, heading }) => ({ id, object_key, object_type, district, longitude, latitude, label, heading })) });
    } catch (error) { next(error); }
  });
  router.use(authenticate, (req, res, next) => {
    if (!ROLES.has(req.user.role) || (req.user.role === 'district_editor' && !req.user.district)) return res.status(403).json({ error: 'Нет доступа к точкам фотофиксации.' });
    next();
  });
  const prefecture = (req, res, next) => req.user.role === 'prefecture_admin' ? next() : res.status(403).json({ error: 'Точки назначает только префектура.' });
  const districtFor = (req) => req.user.role === 'district_editor' ? req.user.district : undefined;
  router.param('id', (req, res, next, id) => UUID.test(id) ? next() : res.status(400).json({ error: 'Некорректный идентификатор точки.' }));
  router.param('photoId', (req, res, next, id) => UUID.test(id) ? next() : res.status(400).json({ error: 'Некорректный идентификатор фото.' }));
  router.get('/', async (req, res, next) => {
    try {
      if (req.query.dataset && req.query.dataset !== 'sao_tpu_parking') return res.status(400).json({ error: 'Неизвестный набор объектов.' });
      const points = await repository.listObjectPhotoPoints({ datasetId: 'sao_tpu_parking', objectKey: req.query.objectKey, district: districtFor(req) || req.query.district });
      res.json({ points });
    } catch (error) { next(error); }
  });
  router.post('/', prefecture, async (req, res, next) => {
    try {
      const validation = validateObjectPhotoPoint(req.body, boundary);
      if (!validation.valid) return res.status(422).json({ error: 'Точка не прошла проверку.', details: validation.errors });
      res.status(201).json({ point: await repository.createObjectPhotoPoint({ ...validation.value, actorId: req.user.sub }) });
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
      const point = await repository.updateObjectPhotoPoint({ id: req.params.id, ...validation.value, actorId: req.user.sub });
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
    async listObjectPhotoPoints({ datasetId, objectKey, district }) {
      const { rows } = await pool.query('SELECT p.*, (SELECT count(*)::integer FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.assignment_version = p.assignment_version) AS photo_count FROM object_photo_points p WHERE retired_at IS NULL AND object_type = \'tpu\' AND dataset_id = $1 AND ($2::text IS NULL OR object_key = $2) AND ($3::text IS NULL OR district = $3) ORDER BY created_at, id', [datasetId, objectKey || null, district || null]);
      return rows;
    },
    async getObjectPhotoPoint({ id, district }) {
      const { rows } = await pool.query('SELECT * FROM object_photo_points WHERE id = $1 AND retired_at IS NULL AND object_type = \'tpu\' AND ($2::text IS NULL OR district = $2)', [id, district || null]);
      return rows[0] || null;
    },
    createObjectPhotoPoint({ datasetId, objectKey, objectType, district, longitude, latitude, label, note, actorId, heading = null }) {
      return write(actorId, 'object_photo_point_created', { datasetId, objectKey }, async (client) => {
        const { rows } = await client.query('INSERT INTO object_photo_points (id, dataset_id, object_key, object_type, district, longitude, latitude, label, note, created_by, updated_by, heading) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11) RETURNING *', [crypto.randomUUID(), datasetId, objectKey, objectType, district, longitude, latitude, label, note, actorId, heading]);
        return rows[0];
      });
    },
    updateObjectPhotoPoint({ id, longitude, latitude, label, note, actorId, heading = null }) {
      return write(actorId, 'object_photo_point_updated', { pointId: id }, async (client) => {
        const { rows } = await client.query('UPDATE object_photo_points SET assignment_version = assignment_version + CASE WHEN longitude IS DISTINCT FROM $2 OR latitude IS DISTINCT FROM $3 OR heading IS DISTINCT FROM $7 THEN 1 ELSE 0 END, longitude = $2, latitude = $3, label = $4, note = $5, updated_by = $6, heading = $7, updated_at = now() WHERE id = $1 AND retired_at IS NULL RETURNING *', [id, longitude, latitude, label, note, actorId, heading]);
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
        const point = await client.query('SELECT id, assignment_version, longitude, latitude FROM object_photo_points WHERE id = $1 AND retired_at IS NULL AND object_type = \'tpu\' AND ($2::text IS NULL OR district = $2) FOR UPDATE', [pointId, district || null]);
        if (!point.rows[0]) return null;
        const assignment = point.rows[0];
        if (expectedVersion !== assignment.assignment_version) throw Object.assign(new Error('Точка изменена префектурой. Обновите карточку и выберите текущий ракурс.'), { status: 409 });
        const { rows } = await client.query(`INSERT INTO object_photo_point_photos (id, point_id, photo_bytes, photo_mime_type, photo_filename, photo_size, uploaded_by, assignment_version, assignment_longitude, assignment_latitude) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${PHOTO_COLUMNS}`, [crypto.randomUUID(), pointId, bytes, mimeType, filename, bytes.length, actorId, assignment.assignment_version, assignment.longitude, assignment.latitude]);
        return rows[0];
      });
    },
    async getObjectPhotoPointPhoto({ pointId, photoId }) {
      const { rows } = await pool.query('SELECT photo_bytes, photo_mime_type, photo_filename FROM object_photo_point_photos WHERE id = $1 AND point_id = $2', [photoId, pointId]);
      return rows[0] || null;
    }
  };
}
