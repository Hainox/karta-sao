// Перенос маркеров объектов на карте ТПУ и парковок. Исходные координаты объекта
// пришли из Excel и выгрузки АСУ ОДХ; префектура перетаскивает маркер, новое место
// хранится в tpu_object_positions и видно всем — на карте и в архиве фото парковок.
// «Отменить» на карте возвращает прежнее место, DELETE — исходное из каталога.
import express from 'express';
import { readFileSync } from 'node:fs';
import { isPointWithinBoundary } from './validation.js';

const CATALOG = JSON.parse(readFileSync(new URL('./tpu-objects.json', import.meta.url), 'utf8'));
const KNOWN = new Set(CATALOG.map((object) => object.id));

export function validateObjectPosition(body, boundary) {
  // Пустое значение — не ноль: Number(null) дал бы координату 0.
  const number = (value) => (value === null || value === '' || value === undefined ? NaN : Number(value));
  const longitude = number(body?.longitude);
  const latitude = number(body?.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
    || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return { error: 'Укажите координаты нового места.' };
  if (boundary && !isPointWithinBoundary([longitude, latitude], boundary)) return { error: 'Новое место объекта должно быть в границах САО.' };
  return { value: { longitude, latitude } };
}

/** Перенесённые места: Map ключ объекта → { lat, lon }. */
export async function loadObjectPositions(db) {
  const { rows } = await db.query('SELECT object_key, longitude, latitude FROM tpu_object_positions');
  return new Map(rows.map((row) => [row.object_key, { lat: Number(row.latitude), lon: Number(row.longitude) }]));
}

/** Объекты каталога с учётом переноса: исходные координаты сохраняются в sourceLat/sourceLon. */
export function withObjectPositions(objects, positions) {
  const result = new Map(objects);
  for (const [key, place] of positions) {
    const object = result.get(key);
    if (object) result.set(key, { ...object, sourceLat: object.lat, sourceLon: object.lon, lat: place.lat, lon: place.lon });
  }
  return result;
}

export function createObjectPositionsRouter({ pool, authenticate, boundary }) {
  const router = express.Router();
  // Места видны всем, кто открывает карту, — как сами объекты.
  router.get('/', async (_req, res, next) => {
    try {
      const { rows } = await pool.query('SELECT object_key, longitude, latitude, updated_at FROM tpu_object_positions ORDER BY object_key');
      res.set('Cache-Control', 'no-store').json({ positions: rows.map((row) => ({
        object_key: row.object_key, longitude: Number(row.longitude), latitude: Number(row.latitude), updated_at: row.updated_at,
      })) });
    } catch (error) { next(error); }
  });
  const prefecture = (req, res, next) => (req.user.role === 'prefecture_admin'
    ? next() : res.status(403).json({ error: 'Переносить объекты может только префектура.' }));
  const audit = (req, action, key, metadata) => pool.query(
    'INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
    [req.user.sub, action, key, JSON.stringify(metadata)]);
  const known = (req, res, next) => (KNOWN.has(req.params.key) ? next() : res.status(404).json({ error: 'Объект не найден.' }));

  router.put('/:key', authenticate, prefecture, known, async (req, res, next) => {
    try {
      const { value, error } = validateObjectPosition(req.body, boundary);
      if (error) return res.status(422).json({ error });
      const { rows } = await pool.query(`INSERT INTO tpu_object_positions (object_key, longitude, latitude, updated_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (object_key) DO UPDATE SET longitude = EXCLUDED.longitude, latitude = EXCLUDED.latitude, updated_at = now(), updated_by = EXCLUDED.updated_by
        RETURNING object_key, longitude, latitude, updated_at`, [req.params.key, value.longitude, value.latitude, req.user.sub]);
      await audit(req, 'tpu_object_moved', req.params.key, value);
      res.json({ position: { ...rows[0], longitude: Number(rows[0].longitude), latitude: Number(rows[0].latitude) } });
    } catch (error) { next(error); }
  });
  router.delete('/:key', authenticate, prefecture, known, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM tpu_object_positions WHERE object_key = $1', [req.params.key]);
      await audit(req, 'tpu_object_position_reset', req.params.key, {});
      res.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}
