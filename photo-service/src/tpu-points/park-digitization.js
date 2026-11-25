import express from 'express';
import { randomUUID } from 'node:crypto';
import { dpspDistrict } from './dpsp-access.js';
import { validateReview } from './object-slots.js';
import { MAX_PHOTO_BYTES, PHOTO_MIME_TYPES, safePhotoFilename, validatePhotoUpload } from './photo-markers.js';
import { DISTRICTS, isPointWithinBoundary } from './validation.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isAdmin = (req) => req.user.role === 'prefecture_admin';
const districtOf = (req) => dpspDistrict(req.user.district);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const pointNotFound = () => fail(404, 'Точка или фотослот не найдены.');
const photoNotFound = () => fail(404, 'Фото не найдено.');
const parkNotFound = () => fail(404, 'Выберите парк в этом районе.');
const toPoint = (row) => ({
  id: row.id,
  parkId: row.park_id,
  coordinates: [row.longitude, row.latitude],
  revision: row.revision,
  locationReason: row.location_reason,
  slot: {
    id: row.frame_id,
    azimuth: row.azimuth,
    status: row.status === 'rejected' ? 'rework' : row.status || 'empty',
    photoId: row.photo_id || null,
    comment: row.review_comment || '',
  },
});

const pointRead = `SELECT p.*, o.district, f.id AS photo_id, f.status, f.review_comment
  FROM park_digitization_points p
  JOIN park_digitization_objects o ON o.id = p.park_id
  LEFT JOIN LATERAL (
    SELECT i.id, i.status, i.review_comment FROM park_digitization_photos i WHERE i.frame_id = p.frame_id
    ORDER BY (i.status <> 'rejected') DESC, i.uploaded_at DESC, i.id DESC LIMIT 1
  ) f ON true
  WHERE p.retired_at IS NULL`;

function position({ coordinates, azimuth, locationReason }, park, boundary) {
  if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
      || !isPointWithinBoundary(coordinates, boundary)) fail(422, 'Укажите точку в пределах САО.');
  if (!Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360) fail(422, 'Укажите направление от 0° до 359,99°.');
  const reason = typeof locationReason === 'string' ? locationReason.trim() : '';
  if (reason.length > 500) fail(422, 'Обоснование должно быть не длиннее 500 символов.');
  const inside = park.geometry && isPointWithinBoundary(coordinates, { features: [{ geometry: park.geometry }] });
  if (!inside && !reason) fail(422, park.geometry
    ? 'Точка за пределами выбранного контура. Укажите, откуда и почему нужно снимать парк.'
    : 'Контур отсутствует. Укажите ориентир и обоснуйте положение точки.');
  return [...coordinates, azimuth, inside ? null : reason];
}

export function createParkDigitizationRouter({ pool, authenticate, boundary }) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  }, authenticate, (req, _res, next) => {
    if (isAdmin(req) || (['district_editor', 'dpsp_district_editor'].includes(req.user.role) && districtOf(req))) return next();
    fail(403, 'Парковая оцифровка доступна префектуре и районным исполнителям.');
  });
  const admin = (req, _res, next) => {
    if (!isAdmin(req)) fail(403, 'Разметку точек и приёмку фото ведёт префектура.');
    next();
  };
  for (const param of ['pointId', 'frameId', 'photoId']) {
    router.param(param, (_req, _res, next, value) => UUID.test(value) ? next() : pointNotFound());
  }
  async function transaction(run) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  const selectPoint = async (client, id) => toPoint((await client.query(pointRead + ' AND p.id = $1', [id])).rows[0]);
  const audit = (client, req, action, point, details = {}) => client.query(
    'INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
    [req.user.id, action, 'park-digitization:' + point.id, JSON.stringify({ parkId: point.park_id, ...details })],
  );
  const visible = (req, district) => isAdmin(req) || districtOf(req) === district;

  async function lockPoint(client, req) {
    const { pointId, frameId } = req.params;
    const key = pointId ? 'p.id' : 'p.frame_id';
    const { rows: [point] } = await client.query(`SELECT p.* FROM park_digitization_points p
      WHERE ${key} = $1 AND p.retired_at IS NULL FOR UPDATE OF p`, [pointId || frameId]);
    if (!point) pointNotFound();
    // Повторная проверка парка после получения блокировки учитывает конкурентный перенос.
    const { rows: [park] } = await client.query('SELECT district, registry_status FROM park_digitization_objects WHERE id = $1 FOR SHARE', [point.park_id]);
    if (!visible(req, park.district) || (!isAdmin(req) && park.registry_status === 'conflict')) pointNotFound();
    return point;
  }
  async function getPark(client, id, district) {
    if (typeof id !== 'string' || !UUID.test(id)) parkNotFound();
    const { rows: [park] } = await client.query('SELECT * FROM park_digitization_objects WHERE id = $1 AND ($2::text IS NULL OR district = $2)', [id, district ?? null]);
    if (!park) parkNotFound();
    return park;
  }
  function checkRevision(value, point) {
    if (value !== point.revision) fail(409, 'Точка уже изменена. Обновите слой перед повторной правкой.');
  }

  router.get('/district', async (req, res) => {
    const { district } = req.query;
    if (!DISTRICTS.has(district)) fail(400, 'Укажите район САО.');
    if (!visible(req, district)) fail(403, 'Доступны парки только своего района.');
    const [parks, points, destinations] = await Promise.all([
      pool.query(`SELECT * FROM park_digitization_objects WHERE district = $1 AND ($2::boolean OR registry_status <> 'conflict')
        ORDER BY name, id`, [district, isAdmin(req)]),
      pool.query(pointRead + ` AND o.district = $1 AND ($2::boolean OR o.registry_status <> 'conflict') ORDER BY p.id`, [district, isAdmin(req)]),
      isAdmin(req) ? pool.query('SELECT id, name, district FROM park_digitization_objects ORDER BY district, name') : null,
    ]);
    res.json({ parks: parks.rows, points: points.rows.map(toPoint), destinations: destinations?.rows });
  });

  router.post('/points', admin, async (req, res) => {
    const input = req.body || {};
    const { id, district, parkId } = input;
    if (!DISTRICTS.has(district) || typeof id !== 'string' || !UUID.test(id)) fail(422, 'Укажите район и идентификатор новой точки.');
    const created = await transaction(async (client) => {
      const park = await getPark(client, parkId, district);
      const values = position(input, park, boundary);
      // Идентификатор черновика переживает повтор POST при потерянном ответе.
      const { rows: [point] } = await client.query(`INSERT INTO park_digitization_points
        (id, park_id, frame_id, longitude, latitude, azimuth, location_reason) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO NOTHING RETURNING *`, [id, park.id, randomUUID(), ...values]);
      if (point) await audit(client, req, 'park_point_created', point);
      else {
        const { rows: [existing] } = await client.query('SELECT * FROM park_digitization_points WHERE id = $1', [id]);
        if (!existing || existing.retired_at || existing.park_id !== park.id || existing.revision !== 1 ||
            existing.longitude !== values[0] || existing.latitude !== values[1] ||
            existing.azimuth !== values[2] || existing.location_reason !== values[3]) {
          fail(409, 'Эта точка уже сохранена в другом состоянии. Обновите слой.');
        }
      }
      return selectPoint(client, id);
    });
    res.status(201).json({ point: created });
  });

  router.patch('/points/:pointId', admin, async (req, res) => {
    const input = req.body || {};
    const updated = await transaction(async (client) => {
      const point = await lockPoint(client, req);
      checkRevision(input.revision, point);
      const park = await getPark(client, input.parkId ?? point.park_id);
      const changesOwner = park.id !== point.park_id;
      if (changesOwner && input.confirmReassignment !== true) fail(409, 'Подтвердите перевод точки в другой парк.');
      const current = toPoint(point);
      const changesLocation = Array.isArray(input.coordinates) && input.coordinates.some((value, index) => value !== current.coordinates[index]);
      const values = position({
        coordinates: input.coordinates ?? current.coordinates, azimuth: input.azimuth ?? current.slot.azimuth,
        locationReason: input.locationReason ?? (changesOwner || changesLocation ? null : point.location_reason),
      }, park, boundary);
      await client.query(`UPDATE park_digitization_points SET park_id = $2, longitude = $3,
        latitude = $4, azimuth = $5, location_reason = $6, revision = revision + 1 WHERE id = $1`,
      [point.id, park.id, ...values]);
      await audit(client, req, 'park_point_updated', point, { newParkId: park.id });
      return selectPoint(client, point.id);
    });
    res.json({ point: updated });
  });

  router.delete('/points/:pointId', admin, async (req, res) => {
    await transaction(async (client) => {
      const point = await lockPoint(client, req);
      checkRevision(req.body?.revision, point);
      const { rowCount } = await client.query('SELECT 1 FROM park_digitization_photos WHERE frame_id = $1 LIMIT 1', [point.frame_id]);
      if (rowCount) fail(409, 'В фотослоте есть фотография или история снимков. Точка защищена от удаления.');
      await client.query('UPDATE park_digitization_points SET retired_at = now(), revision = revision + 1 WHERE id = $1', [point.id]);
      await audit(client, req, 'park_point_retired', point);
    });
    res.json({ deleted: true });
  });

  router.get('/frames/:frameId/photos/:photoId', async (req, res) => {
    const { rows: [photo] } = await pool.query(`SELECT f.photo_bytes, f.photo_mime_type
      FROM park_digitization_photos f JOIN park_digitization_points p ON p.frame_id = f.frame_id
      JOIN park_digitization_objects o ON o.id = p.park_id
      WHERE f.frame_id = $1 AND f.id = $2 AND p.retired_at IS NULL AND ($3::boolean OR (o.district = $4 AND o.registry_status <> 'conflict'))`,
    [req.params.frameId, req.params.photoId, isAdmin(req), districtOf(req) || null]);
    if (!photo) photoNotFound();
    res.set('X-Content-Type-Options', 'nosniff').type(photo.photo_mime_type).send(photo.photo_bytes);
  });

  const photoBody = express.raw({ type: [...PHOTO_MIME_TYPES], limit: MAX_PHOTO_BYTES });
  router.put('/frames/:frameId/photo', photoBody, async (req, res) => {
    const valid = validatePhotoUpload(req.body, req.get('content-type'));
    if (!valid.valid) fail(422, valid.error);
    const photo = await transaction(async (client) => {
      const point = await lockPoint(client, req);
      const { rows: [item] } = await client.query(`INSERT INTO park_digitization_photos
        (id, frame_id, status, photo_bytes, photo_mime_type, photo_filename, uploaded_by)
        VALUES ($1,$2,'pending',$3,$4,$5,$6) ON CONFLICT (frame_id) WHERE status IN ('pending','accepted')
        DO NOTHING RETURNING id, status`,
      [randomUUID(), point.frame_id, req.body, valid.mimeType, safePhotoFilename(req.get('x-photo-filename')), req.user.id]);
      if (!item) fail(409, 'В фотослоте уже есть действующий снимок. Обновите слой.');
      await audit(client, req, 'park_photo_uploaded', point, { photoId: item.id });
      return item;
    });
    res.status(201).json({ photo });
  });

  router.post('/frames/:frameId/photos/:photoId/review', admin, async (req, res) => {
    const review = validateReview(req.body);
    if (!review.valid) fail(422, review.error);
    const photo = await transaction(async (client) => {
      const point = await lockPoint(client, req);
      const { decision, comment } = review.value;
      const { rows: [item] } = await client.query(`UPDATE park_digitization_photos SET status = $3, review_comment = $4,
        reviewed_by = $5, reviewed_at = now() WHERE frame_id = $1 AND id = $2 AND status = 'pending' RETURNING id, status`,
      [point.frame_id, req.params.photoId, decision, comment, req.user.id]);
      if (!item) fail(409, 'Снимок уже проверен или недоступен для этой точки.');
      await audit(client, req, 'park_photo_reviewed', point, { photoId: item.id, decision });
      return item;
    });
    res.json({ photo });
  });

  return router;
}
