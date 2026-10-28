// Точки съёмки тротуаров у МКД. Пока это тестовая оцифровка: точки видит и
// правит только префектура (перенос, направление кадра, удаление). Фото к ним
// не загружаются. Каждая правка пишется в audit_log.
import express from 'express';
import { DISTRICTS, isPointWithinBoundary } from './validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, point_no, district, address, unom, role, side, also_covers, longitude, latitude, heading, status, updated_at';

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

export function createSidewalkPointsRouter({ pool, authenticate, boundary }) {
  const router = express.Router();
  router.use(authenticate, (req, res, next) => req.user.role === 'prefecture_admin'
    ? next() : res.status(403).json({ error: 'Точки съёмки тротуаров пока доступны только префектуре.' }));
  router.param('id', (req, res, next, id) => UUID.test(id) ? next() : res.status(400).json({ error: 'Некорректный идентификатор точки.' }));

  router.get('/', async (req, res, next) => {
    try {
      const district = typeof req.query.district === 'string' ? req.query.district.trim() : '';
      if (!DISTRICTS.has(district)) return res.status(400).json({ error: 'Укажите район САО.' });
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM sidewalk_photo_points WHERE district = $1 AND retired_at IS NULL ORDER BY point_no`, [district]);
      res.set('Cache-Control', 'private, no-store').json({ points: rows });
    } catch (error) { next(error); }
  });

  const write = async (req, action, sql, params) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(sql, params);
      if (rows[0]) {
        await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
          [req.user.sub, action, `sidewalk:${rows[0].point_no}`, JSON.stringify({ id: rows[0].id, ...req.body })]);
      }
      await client.query('COMMIT');
      return rows[0] || null;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* исходная ошибка важнее */ }
      throw error;
    } finally { client.release(); }
  };

  router.patch('/:id', async (req, res, next) => {
    try {
      const { value, error } = validateSidewalkPatch(req.body, boundary);
      if (error) return res.status(422).json({ error });
      const sets = Object.keys(value).map((key, i) => `${key} = $${i + 3}`);
      const point = await write(req, 'sidewalk_point_update',
        `UPDATE sidewalk_photo_points SET ${sets.join(', ')}, updated_at = now(), updated_by = $2
         WHERE id = $1 AND retired_at IS NULL RETURNING ${COLUMNS}`,
        [req.params.id, req.user.sub, ...Object.values(value)]);
      if (!point) return res.status(404).json({ error: 'Точка не найдена.' });
      res.json({ point });
    } catch (error) { next(error); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const point = await write(req, 'sidewalk_point_retire',
        `UPDATE sidewalk_photo_points SET retired_at = now(), updated_at = now(), updated_by = $2
         WHERE id = $1 AND retired_at IS NULL RETURNING ${COLUMNS}`,
        [req.params.id, req.user.sub]);
      if (!point) return res.status(404).json({ error: 'Точка не найдена.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}
