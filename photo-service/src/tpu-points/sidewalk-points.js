import { acceptedPhotoBytes, mountAcceptedPhotoExport } from './accepted-photo-export.js';
// Точки съёмки тротуаров у МКД. Пока префектура согласовывает расстановку,
// список точек видит свой район; правит только префектура (перенос, направление кадра,
// удаление). Фото к точке загружает район своей точки или префектура: один
// слот на точку, как у площадок ДП/СП. Каждое действие пишется в audit_log.
import crypto from 'node:crypto';
import express from 'express';
import { DISTRICTS, isPointWithinBoundary } from './validation.js';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';
import { districtQueueFromRows, slotPointsForReport } from './district-point-photos.js';
import { buildDigitizationReport, summarizeDigitization } from '../digitization-report.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, point_no, district, address, unom, role, side, also_covers, longitude, latitude, heading, status, updated_at';
// Состояние слота как у площадок: «нет фото / на проверке / принято / на доработке».
const PHOTO_STATE = `COALESCE(
  (SELECT f.status FROM sidewalk_photo_slot_photos f WHERE f.point_id = p.id AND f.status IN ('pending', 'accepted') ORDER BY f.uploaded_at DESC LIMIT 1),
  (SELECT 'rework' FROM sidewalk_photo_slot_photos f WHERE f.point_id = p.id AND f.status = 'rejected' ORDER BY f.reviewed_at DESC NULLS LAST LIMIT 1),
  'empty') AS photo_state`;
const POINT_COLUMNS = COLUMNS.split(', ').map((c) => 'p.' + c).join(', ');

/** Проверка правки: только координаты и направление, координаты — в границах САО. */
export function validateSidewalkPatch(body, boundary) {
  const keys = Object.keys(body || {});
  if (!keys.length || keys.some((key) => !['longitude', 'latitude', 'heading'].includes(key))) {
    return { error: 'Можно изменить только место точки и направление кадра.' };
  }
  const hasLon = 'longitude' in body;
  if (hasLon !== ('latitude' in body)) return { error: 'Укажите обе координаты точки.' };
  const value = {};
  if (hasLon) {
    const { longitude, latitude } = body;
    if (![longitude, latitude].every((n) => typeof n === 'number' && Number.isFinite(n))) return { error: 'Некорректные координаты.' };
    if (!isPointWithinBoundary([longitude, latitude], boundary)) return { error: 'Точка должна находиться в границах САО.' };
    Object.assign(value, { longitude, latitude });
  }
  if ('heading' in body) {
    const { heading } = body;
    if (typeof heading !== 'number' || !Number.isFinite(heading)) return { error: 'Направление должно быть числом от 0 до 359 градусов.' };
    value.heading = ((Math.round(heading) % 360) + 360) % 360;
  }
  return { value };
}

/** Новая точка, которую префектура ставит «Разметкой»: район, место и направление кадра. */
export function validateSidewalkCreate(body, boundary) {
  const { district, longitude, latitude, heading } = body || {};
  if (!DISTRICTS.has(district)) return { error: 'Укажите район САО.' };
  if (longitude === undefined || latitude === undefined || heading === undefined) return { error: 'Укажите место точки и направление кадра.' };
  const { value, error } = validateSidewalkPatch({ longitude, latitude, heading }, boundary);
  return error ? { error } : { value: { district, ...value } };
}

/** Следующий номер точки района: «Т1.386» после «Т1.385». Номера снятых точек не переиспользуются. */
export function nextSidewalkPointNo(district, taken) {
  const prefix = `Т${[...DISTRICTS].indexOf(district) + 1}.`;
  let max = 0;
  for (const no of taken) {
    if (!no.startsWith(prefix)) continue;
    const n = Number(no.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(3, '0');
}

export const sidewalkQueueQuery = `SELECT p.id AS point_id,
  p.point_no || CASE WHEN COALESCE(p.address, '') = '' THEN '' ELSE ' · ' || p.address END AS label,
  p.district, p.heading, p.longitude, p.latitude, p.point_no AS object_id,
  f.id AS photo_id, f.status AS photo_status, f.uploaded_at, f.photo_filename, f.reviewed_at,
  r.id AS rejected_photo_id, r.review_comment AS rejected_comment, r.reviewed_at AS rejected_at,
  r.uploaded_at AS rejected_uploaded_at, r.photo_filename AS rejected_photo_filename
  FROM sidewalk_photo_points p
  LEFT JOIN LATERAL (SELECT t.id,t.status,t.uploaded_at,t.photo_filename,t.reviewed_at FROM sidewalk_photo_slot_photos t
    WHERE t.point_id=p.id AND t.status IN ('pending','accepted') ORDER BY t.uploaded_at DESC,t.id DESC LIMIT 1) f ON true
  LEFT JOIN LATERAL (SELECT t.id,t.review_comment,t.reviewed_at,t.uploaded_at,t.photo_filename FROM sidewalk_photo_slot_photos t
    WHERE t.point_id=p.id AND t.status='rejected' ORDER BY t.reviewed_at DESC NULLS LAST,t.id DESC LIMIT 1) r ON true
  WHERE p.retired_at IS NULL`;

export function sidewalkQueueFromRows(rows) {
  const queue = districtQueueFromRows(rows);
  // Как у ДП/СП: маршрут снимка отдаёт только действующее фото.
  return { ...queue, rework: queue.rework.map(row => ({ ...row, photo_id: null })) };
}

export function createSidewalkPointsRouter({ pool, authenticate, boundary }) {
  const router = express.Router();
  router.use(authenticate, (req, res, next) => (req.user.role === 'prefecture_admin'
    || (req.user.role === 'district_editor' && req.user.district))
    ? next() : res.status(403).json({ error: 'Нет доступа к точкам съёмки тротуаров.' }));
  router.param('id', (req, res, next, id) => UUID.test(id) ? next() : res.status(400).json({ error: 'Некорректный идентификатор точки.' }));
  const prefecture = (req, res, next) => req.user.role === 'prefecture_admin'
    ? next() : res.status(403).json({ error: 'Точки съёмки тротуаров пока доступны только префектуре.' });
  // Фото: префектура — любая точка, район — только точки своего района.
  const permitted = (user, point) => user.role === 'prefecture_admin' || user.district === point.district;

  const audit = (client, req, action, objectKey, metadata) => client.query(
    'INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
    [req.user.sub, action, objectKey, JSON.stringify(metadata)]);

  const transaction = async (operation) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query(result?.rollback ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* исходная ошибка важнее */ }
      throw error;
    } finally { client.release(); }
  };

  router.get('/queue', prefecture, async (req, res, next) => {
    try { res.set('Cache-Control', 'private, no-store').json(sidewalkQueueFromRows((await pool.query(sidewalkQueueQuery)).rows)); }
    catch (error) { next(error); }
  });
  mountAcceptedPhotoExport(router, {
    prefecture, category: 'Тротуары Дворы', allowKind: false,
    loadRows: async () => (await pool.query(sidewalkQueueQuery)).rows,
    loadPhoto: row => acceptedPhotoBytes(pool, row, 'sidewalk_photo_slot_photos'),
  });
  router.get('/report.xlsx', prefecture, async (req, res, next) => {
    try {
      const generatedAt = new Date();
      const summary = summarizeDigitization({ points: slotPointsForReport((await pool.query(sidewalkQueueQuery)).rows), generatedAt });
      const buffer = await buildDigitizationReport(summary, {
        title: 'Оцифровка тротуаров ДТ', pointTitle: 'Точка тротуара',
      });
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(generatedAt);
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Svod_foto_trotuary_SAO_${day}.xlsx"`, 'Cache-Control': 'private, no-store' }).send(buffer);
    } catch (error) { next(error); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const requestedDistrict = typeof req.query.district === 'string' ? req.query.district.trim() : '';
      if (req.user.role === 'district_editor' && requestedDistrict && requestedDistrict !== req.user.district) {
        return res.status(403).json({ error: 'Доступны только точки своего района.' });
      }
      const district = req.user.role === 'district_editor' ? req.user.district : requestedDistrict;
      if (!DISTRICTS.has(district)) return res.status(400).json({ error: 'Укажите район САО.' });
      const { rows } = await pool.query(`SELECT ${POINT_COLUMNS}, ${PHOTO_STATE} FROM sidewalk_photo_points p
        WHERE p.district = $1 AND p.retired_at IS NULL ORDER BY p.point_no`, [district]);
      res.set('Cache-Control', 'private, no-store').json({ points: rows });
    } catch (error) { next(error); }
  });

  const writePoint = (req, action, sql, params) => transaction(async (client) => {
    const { rows } = await client.query(sql, params);
    if (rows[0]) await audit(client, req, action, `sidewalk:${rows[0].point_no}`, { id: rows[0].id, ...req.body });
    return rows[0] || null;
  });

  router.post('/', prefecture, async (req, res, next) => {
    try {
      const { value, error } = validateSidewalkCreate(req.body, boundary);
      if (error) return res.status(422).json({ error });
      const point = await transaction(async (client) => {
        // Номер выдаётся под блокировкой района: две одновременные разметки не получат один номер.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sidewalk_point_no:' + value.district]);
        const prefix = `Т${[...DISTRICTS].indexOf(value.district) + 1}.`;
        const taken = (await client.query('SELECT point_no FROM sidewalk_photo_points WHERE point_no LIKE $1', [prefix + '%'])).rows.map((r) => r.point_no);
        const { rows } = await client.query(`INSERT INTO sidewalk_photo_points
          (id, point_no, district, role, longitude, latitude, heading, status, updated_by)
          VALUES ($1, $2, $3, 'добавлена префектурой', $4, $5, $6, 'черновик', $7) RETURNING ${COLUMNS}`,
        [crypto.randomUUID(), nextSidewalkPointNo(value.district, taken), value.district, value.longitude, value.latitude, value.heading, req.user.sub]);
        await audit(client, req, 'sidewalk_point_create', `sidewalk:${rows[0].point_no}`, { id: rows[0].id, ...value });
        return rows[0];
      });
      res.status(201).json({ point: { ...point, photo_state: 'empty' } });
    } catch (error) { next(error); }
  });

  router.patch('/:id', prefecture, async (req, res, next) => {
    try {
      const { value, error } = validateSidewalkPatch(req.body, boundary);
      if (error) return res.status(422).json({ error });
      const sets = Object.keys(value).map((key, i) => `${key} = $${i + 3}`);
      const point = await writePoint(req, 'sidewalk_point_update',
        `UPDATE sidewalk_photo_points SET ${sets.join(', ')}, updated_at = now(), updated_by = $2
         WHERE id = $1 AND retired_at IS NULL RETURNING ${COLUMNS}`,
        [req.params.id, req.user.sub, ...Object.values(value)]);
      if (!point) return res.status(404).json({ error: 'Точка не найдена.' });
      res.json({ point });
    } catch (error) { next(error); }
  });

  router.delete('/:id', prefecture, async (req, res, next) => {
    try {
      const point = await writePoint(req, 'sidewalk_point_retire',
        `UPDATE sidewalk_photo_points SET retired_at = now(), updated_at = now(), updated_by = $2
         WHERE id = $1 AND retired_at IS NULL RETURNING ${COLUMNS}`,
        [req.params.id, req.user.sub]);
      if (!point) return res.status(404).json({ error: 'Точка не найдена.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  const findPoint = async (db, id, lock = false) => (await db.query(
    `SELECT id, point_no, district FROM sidewalk_photo_points WHERE id = $1 AND retired_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];

  // Слот фото: действующий снимок и последний возврат с причиной.
  router.get('/:id/slot', async (req, res, next) => {
    try {
      const point = await findPoint(pool, req.params.id);
      if (!point || !permitted(req.user, point)) return res.status(404).json({ error: 'Точка не найдена.' });
      const { rows } = await pool.query(`SELECT id, status, photo_filename, uploaded_at, review_comment, reviewed_at
        FROM sidewalk_photo_slot_photos WHERE point_id = $1 AND status IN ('pending', 'accepted', 'rejected')
        ORDER BY uploaded_at DESC LIMIT 10`, [point.id]);
      const active = rows.find((r) => r.status === 'pending' || r.status === 'accepted') || null;
      const rejected = active ? null : rows.find((r) => r.status === 'rejected') || null;
      res.set('Cache-Control', 'private, no-store').json({ active, rejected });
    } catch (error) { next(error); }
  });

  router.get('/:id/photo', async (req, res, next) => {
    try {
      const point = await findPoint(pool, req.params.id);
      if (!point || !permitted(req.user, point)) return res.status(404).json({ error: 'Точка не найдена.' });
      const photo = (await pool.query(`SELECT photo_mime_type, photo_bytes FROM sidewalk_photo_slot_photos
        WHERE point_id = $1 AND status IN ('pending', 'accepted') ORDER BY uploaded_at DESC LIMIT 1`, [point.id])).rows[0];
      if (!photo) return res.status(404).json({ error: 'Фото отсутствует.' });
      res.set('Cache-Control', 'private, no-store').type(photo.photo_mime_type).send(photo.photo_bytes);
    } catch (error) { next(error); }
  });

  router.put('/:id/photo', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), async (req, res, next) => {
    try {
      const valid = validatePhotoUpload(req.body, req.get('content-type'));
      if (!valid.valid) return res.status(422).json({ error: valid.error });
      const result = await transaction(async (client) => {
        const point = await findPoint(client, req.params.id, true);
        if (!point || !permitted(req.user, point)) return { rollback: true, code: 404, error: 'Точка не найдена.' };
        const active = await client.query(`SELECT 1 FROM sidewalk_photo_slot_photos WHERE point_id = $1 AND status IN ('pending', 'accepted')`, [point.id]);
        if (active.rowCount) return { rollback: true, code: 409, error: 'У точки уже есть фото.' };
        const id = crypto.randomUUID();
        const status = req.user.role === 'prefecture_admin' ? 'accepted' : 'pending';
        await client.query(`INSERT INTO sidewalk_photo_slot_photos (id, point_id, status, photo_bytes, photo_mime_type, photo_filename, photo_size, uploaded_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, point.id, status, req.body, valid.mimeType, safePhotoFilename(req.get('x-photo-filename')), req.body.length, req.user.sub]);
        await audit(client, req, 'sidewalk_photo_uploaded', `sidewalk:${point.point_no}`, { pointId: point.id, photoId: id, status });
        return { id, status };
      });
      if (result.code) return res.status(result.code).json({ error: result.error });
      res.status(201).json(result);
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'У точки уже есть фото.' });
      next(error);
    }
  });

  router.post('/:id/review', prefecture, async (req, res, next) => {
    try {
      const decision = req.body?.decision;
      const comment = String(req.body?.comment || '').trim();
      if (!['accepted', 'rejected'].includes(decision) || comment.length > 2000 || (decision === 'rejected' && !comment)) {
        return res.status(422).json({ error: 'Укажите решение и причину возврата.' });
      }
      const result = await transaction(async (client) => {
        const { rows } = await client.query(`UPDATE sidewalk_photo_slot_photos SET status = $2, review_comment = $3, reviewed_by = $4, reviewed_at = now()
          WHERE point_id = $1 AND status = 'pending' RETURNING id`, [req.params.id, decision, comment, req.user.sub]);
        if (!rows[0]) return { rollback: true };
        await audit(client, req, 'sidewalk_photo_reviewed', req.params.id, { photoId: rows[0].id, decision });
        return { status: decision };
      });
      if (!result.status) return res.status(409).json({ error: 'Нет фото, ожидающего проверки.' });
      res.json(result);
    } catch (error) { next(error); }
  });

  // Префектура убирает действующий снимок (например, загруженный не к той точке):
  // он остаётся в истории, слот снова свободен.
  router.delete('/:id/photo', prefecture, async (req, res, next) => {
    try {
      const result = await transaction(async (client) => {
        const { rows } = await client.query(`UPDATE sidewalk_photo_slot_photos SET status = 'superseded', reviewed_by = $2, reviewed_at = now()
          WHERE point_id = $1 AND status IN ('pending', 'accepted') RETURNING id`, [req.params.id, req.user.sub]);
        if (!rows[0]) return { rollback: true };
        await audit(client, req, 'sidewalk_photo_removed', req.params.id, { photoId: rows[0].id });
        return { removed: true };
      });
      if (!result.removed) return res.status(404).json({ error: 'Фото отсутствует.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}

