import { readFileSync } from 'node:fs';
import { districtForPoint } from '../districts.js';

export const DIRECTION_OBJECTS = new Map(JSON.parse(readFileSync(new URL('./direction-objects.json', import.meta.url), 'utf8')).map(row => [row.fid, row]));
const boundaries = JSON.parse(readFileSync(new URL('./districts_wgs84.geojson', import.meta.url), 'utf8')).features;

export function mountPublicDirectionRoutes(router, { repository }) {
  router.get('/directions/public', async (req, res, next) => {
    try {
      const fids = [...DIRECTION_OBJECTS.values()].filter(row => !req.query.district || row.district === req.query.district).map(row => row.fid);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ corrections: await repository.listDirectionCorrections({ fids }) });
    } catch (error) { next(error); }
  });
}

export function mountDirectionRoutes(router, { repository }) {
  router.patch('/directions/:fid', (req, res, next) => req.user.role === 'prefecture_admin' ? next() : res.status(403).json({ error: 'Направления корректирует только префектура.' }), async (req, res, next) => {
    try {
      const fid = Number(req.params.fid);
      const object = DIRECTION_OBJECTS.get(fid);
      if (!Number.isInteger(fid) || !object) return res.status(404).json({ error: 'Направление не найдено.' });
      const { longitude, latitude, azimuth, expectedVersion } = req.body || {};
      if (typeof azimuth !== 'number' || !Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360 || typeof longitude !== 'number' || typeof latitude !== 'number' || !Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        return res.status(422).json({ error: 'Некорректные координаты, азимут или версия направления.' });
      }
      if (districtForPoint(latitude, longitude, boundaries) !== object.district) return res.status(422).json({ error: 'Точка должна оставаться в районе «' + object.district + '».' });
      const correction = await repository.updateDirectionCorrection({ fid, longitude, latitude, azimuth, expectedVersion, actorId: req.user.sub });
      res.json({ correction });
    } catch (error) { next(error); }
  });
}

export function createDirectionRepository(pool, write) {
  return {
    async listDirectionCorrections({ fids }) {
      const { rows } = await pool.query('SELECT fid, longitude, latitude, azimuth, version FROM district_direction_corrections WHERE fid = ANY($1::integer[]) ORDER BY fid', [fids]);
      return rows;
    },
    updateDirectionCorrection({ fid, longitude, latitude, azimuth, expectedVersion, actorId }) {
      return write(actorId, 'district_direction_corrected', { objectKey: 'direction180:' + fid, longitude, latitude, azimuth }, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['direction180:' + fid]);
        const current = await client.query('SELECT version FROM district_direction_corrections WHERE fid = $1', [fid]);
        if ((current.rows[0]?.version ?? 0) !== expectedVersion) throw Object.assign(new Error('Направление уже изменено. Загружено актуальное положение; повторите корректировку.'), { status: 409 });
        const { rows } = await client.query('INSERT INTO district_direction_corrections (fid, longitude, latitude, azimuth, updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (fid) DO UPDATE SET longitude = EXCLUDED.longitude, latitude = EXCLUDED.latitude, azimuth = EXCLUDED.azimuth, updated_by = EXCLUDED.updated_by, updated_at = now(), version = district_direction_corrections.version + 1 RETURNING fid, longitude, latitude, azimuth, version', [fid, longitude, latitude, azimuth, actorId]);
        return { id: 'direction180:' + fid, ...rows[0] };
      });
    }
  };
}
