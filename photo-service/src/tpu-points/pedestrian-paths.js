// Оцифровка пешеходных дорожек АСУ ОДС: каталог точек съёмки, загрузка,
// приёмка и выгрузки. Раздел кабинета повторяет ДП/СП, но единица учёта —
// точка вдоль трассы, а не площадка: у длинной дорожки их несколько.
//
// Загружает и принимает только префектура: слой дорожек пока виден лишь ей,
// районные учётки его не получают.
import crypto from 'node:crypto';
import express from 'express';
import { readFileSync } from 'node:fs';
import { acceptedPhotoBytes, mountAcceptedPhotoExport } from './accepted-photo-export.js';
import { buildDigitizationReport, summarizeDigitization } from '../digitization-report.js';
import { mountDistrictPhotoArchive } from './district-archive.js';
import { districtQueueFromRows, pointState } from './district-point-photos.js';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';
import { DISTRICTS } from './validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PATH_QUEUE_SQL = `SELECT p.id AS point_id, p.point_no, p.path_id, p.ordinal, p.district, p.address,
  p.longitude, p.latitude, p.route_m, p.area, p.coating, p.updated_at,
  p.popular, p.popular_rank, p.popular_score,
  f.id AS photo_id, f.status AS photo_status, f.uploaded_at, f.photo_filename, f.reviewed_at, f.review_comment,
  r.id AS rejected_photo_id, r.review_comment AS rejected_comment, r.reviewed_at AS rejected_at,
  r.uploaded_at AS rejected_uploaded_at, r.photo_filename AS rejected_photo_filename
  FROM pedestrian_path_points p
  LEFT JOIN LATERAL (SELECT t.id, t.status, t.uploaded_at, t.photo_filename, t.reviewed_at, t.review_comment
    FROM pedestrian_path_photos t
    WHERE t.point_id = p.id AND t.status IN ('pending', 'accepted')
    ORDER BY t.uploaded_at DESC, t.id DESC LIMIT 1) f ON true
  LEFT JOIN LATERAL (SELECT t.id, t.review_comment, t.reviewed_at, t.uploaded_at, t.photo_filename
    FROM pedestrian_path_photos t
    WHERE t.point_id = p.id AND t.status = 'rejected'
    ORDER BY t.reviewed_at DESC NULLS LAST, t.id DESC LIMIT 1) r ON true
  WHERE p.retired_at IS NULL
  ORDER BY p.district, p.point_no`;

/** Точки одного района для слоя на карте: координаты и состояние съёмки. */
export const PATH_DISTRICT_POINTS_SQL = `SELECT p.id AS point_id, p.point_no, p.path_id, p.ordinal,
  p.district, p.address, p.longitude, p.latitude, p.route_m, p.area,
  p.popular, p.popular_rank, p.popular_score,
  COALESCE(a.status, CASE WHEN r.id IS NOT NULL THEN 'rework' ELSE 'empty' END) AS photo_state
  FROM pedestrian_path_points p
  LEFT JOIN LATERAL (SELECT t.status FROM pedestrian_path_photos t
    WHERE t.point_id = p.id AND t.status IN ('pending', 'accepted')
    ORDER BY t.uploaded_at DESC, t.id DESC LIMIT 1) a ON true
  LEFT JOIN LATERAL (SELECT t.id FROM pedestrian_path_photos t
    WHERE t.point_id = p.id AND t.status = 'rejected'
    ORDER BY t.reviewed_at DESC NULLS LAST, t.id DESC LIMIT 1) r ON true
  WHERE p.district = $1 AND p.retired_at IS NULL
  ORDER BY p.point_no`;

/** Подпись точки: адрес и, если точек несколько, номер вдоль трассы. */
export function pathLabel(row) {
  const address = (row.address || '').trim();
  const base = address || 'Дорожка ' + row.path_id;
  return Number(row.ordinal) > 1 ? `${base} · точка ${row.ordinal}` : base;
}

/** Каталог в том же виде, что очередь ДП/СП, плюс список точек без фото. */
export function pedestrianQueueFromRows(rows) {
  const mapped = rows.map((row) => ({ ...row, label: pathLabel(row), heading: null }));
  const queue = districtQueueFromRows(mapped);
  const byId = new Map(mapped.map((row) => [row.point_id, row]));
  const enrich = (row) => {
    const source = byId.get(row.point_id);
    return source ? {
      ...row, point_no: source.point_no, path_id: source.path_id, ordinal: source.ordinal,
      route_m: source.route_m, area: source.area, coating: source.coating, address: source.address,
      popular: source.popular === true, popular_rank: source.popular_rank, popular_score: source.popular_score,
    } : row;
  };
  queue.pending = queue.pending.map(enrich);
  queue.rework = queue.rework.map(enrich);
  queue.empty = mapped
    .filter((row) => pointState(row).status === 'empty')
    .map((row) => ({
      point_id: row.point_id, point_no: row.point_no, path_id: row.path_id, label: row.label,
      district: row.district, heading: null, longitude: row.longitude, latitude: row.latitude,
      route_m: row.route_m, area: row.area, ordinal: row.ordinal, coating: row.coating,
      address: row.address, photo_id: null,
      popular: row.popular === true, popular_rank: row.popular_rank, popular_score: row.popular_score,
    }));
  return queue;
}

/** Строки для Excel-свода: одна точка = одна строка, как у остальных оцифровок. */
export function pathReportPoints(rows) {
  return rows.map((row) => {
    const state = pointState(row);
    return {
      district: row.district,
      label: pathLabel(row),
      kind: null,
      state: state.status,
      lastPhotoAt: state.photo?.uploaded_at || state.rejected?.uploaded_at || null,
      rejectedComment: state.rejected?.comment || '',
      rejectedAt: state.rejected?.reviewed_at || null,
    };
  });
}

export function createPedestrianPathsRouter({ pool, authenticate }) {
  const router = express.Router();
  const prefecture = (req, res, next) => req.user.role === 'prefecture_admin'
    ? next() : res.status(403).json({ error: 'Раздел пешеходных дорожек доступен только префектуре.' });
  const point = async (id) => {
    if (!UUID.test(id)) return null;
    const { rows } = await pool.query('SELECT id, district FROM pedestrian_path_points WHERE id = $1 AND retired_at IS NULL', [id]);
    return rows[0] || null;
  };

  router.use(authenticate, prefecture);
  router.param('id', (req, res, next, id) => UUID.test(id) ? next() : res.status(400).json({ error: 'Неверный ID точки.' }));

  mountDistrictPhotoArchive(router, {
    prefecture, prefix: 'sao-pedestrian-paths',
    loadRows: async () => (await pool.query(PATH_QUEUE_SQL)).rows,
    loadPhoto: (entry) => pool.query('SELECT photo_bytes FROM pedestrian_path_photos WHERE id = $1 AND point_id = $2', [entry.photoId, entry.pointId])
      .then((result) => result.rows[0]?.photo_bytes),
  });
  mountAcceptedPhotoExport(router, {
    prefecture, category: 'Пешеходные дорожки',
    loadRows: async () => (await pool.query(PATH_QUEUE_SQL)).rows,
    loadPhoto: (row) => acceptedPhotoBytes(pool, row, 'pedestrian_path_photos'),
  });

  router.get('/queue', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(pedestrianQueueFromRows((await pool.query(PATH_QUEUE_SQL)).rows));
    } catch (error) { next(error); }
  });

  // Слой точек съёмки для карты района: только координаты и состояние.
  // Очередь кабинета для карты слишком тяжёлая — здесь один район.
  router.get('/shoot-points', async (req, res, next) => {
    try {
      const district = String(req.query.district || '').trim();
      if (!DISTRICTS.has(district)) return res.status(400).json({ error: 'Неизвестный район.' });
      const { rows } = await pool.query(PATH_DISTRICT_POINTS_SQL, [district]);
      res.set('Cache-Control', 'private, no-store').json({ district, points: rows });
    } catch (error) { next(error); }
  });

  router.get('/report.xlsx', async (req, res, next) => {
    try {
      const generatedAt = new Date();
      const points = pathReportPoints((await pool.query(PATH_QUEUE_SQL)).rows);
      const summary = summarizeDigitization({ points, generatedAt });
      const buffer = await buildDigitizationReport(summary, {
        title: 'Пешеходные дорожки · АСУ ОДС',
        pointTitle: 'Точка съёмки',
      });
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(generatedAt);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Svod_foto_peshehodnye_dorozhki_SAO_${day}.xlsx"`,
        'Cache-Control': 'no-store',
      }).send(buffer);
    } catch (error) { next(error); }
  });

  // Отдаём активный снимок, а если его нет — последний возвращённый: в карточке
  // «на доработке» префектура должна видеть, за что вернули точку.
  router.get('/:id/photo', async (req, res, next) => {
    try {
      const found = await point(req.params.id);
      if (!found) return res.status(404).json({ error: 'Точка не найдена.' });
      const { rows } = await pool.query(`SELECT photo_mime_type, photo_bytes FROM pedestrian_path_photos
        WHERE point_id = $1 AND status IN ('pending', 'accepted', 'rejected')
        ORDER BY (status IN ('pending', 'accepted')) DESC, uploaded_at DESC, id DESC LIMIT 1`, [found.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Фото не загружено.' });
      res.set('Cache-Control', 'private, no-store').type(rows[0].photo_mime_type).send(rows[0].photo_bytes);
    } catch (error) { next(error); }
  });

  router.put('/:id/photo', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), async (req, res, next) => {
    const valid = validatePhotoUpload(req.body, req.get('content-type'));
    if (!valid.valid) return res.status(422).json({ error: valid.error });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT id, district FROM pedestrian_path_points WHERE id = $1 AND retired_at IS NULL FOR UPDATE', [req.params.id]);
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Точка не найдена.' }); }
      const active = await client.query(`SELECT 1 FROM pedestrian_path_photos WHERE point_id = $1 AND status IN ('pending', 'accepted')`, [rows[0].id]);
      if (active.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Фото уже загружено: сначала примите его или верните на доработку.' }); }
      const id = crypto.randomUUID();
      await client.query(`INSERT INTO pedestrian_path_photos
        (id, point_id, status, photo_bytes, photo_mime_type, photo_filename, photo_size, uploaded_by)
        VALUES ($1,$2,'pending',$3,$4,$5,$6,$7)`,
      [id, rows[0].id, req.body, valid.mimeType, safePhotoFilename(req.get('x-photo-filename')), req.body.length, req.user.sub]);
      await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
        [req.user.sub, 'pedestrian_path_photo_uploaded', `pedestrian:${rows[0].id}`, JSON.stringify({ pointId: rows[0].id, photoId: id })]);
      await client.query('COMMIT');
      res.status(201).json({ id, status: 'pending' });
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch (_) { /* исходная ошибка важнее */ }
      if (error.code === '23505') return res.status(409).json({ error: 'Фото уже загружено.' });
      next(error);
    } finally { if (client) client.release(); }
  });

  router.post('/:id/review', async (req, res, next) => {
    let client;
    try {
      const decision = req.body?.decision;
      const comment = String(req.body?.comment || '').trim();
      if (!['accepted', 'rejected'].includes(decision) || comment.length > 2000 || (decision === 'rejected' && !comment)) {
        return res.status(422).json({ error: 'Нужно решение и причина возврата.' });
      }
      client = await pool.connect();
      await client.query('BEGIN');
      const found = await client.query(`UPDATE pedestrian_path_photos SET status = $2, review_comment = $3,
        reviewed_by = $4, reviewed_at = now()
        WHERE id = (SELECT id FROM pedestrian_path_photos WHERE point_id = $1 AND status = 'pending'
          ORDER BY uploaded_at DESC, id DESC LIMIT 1)
        AND status = 'pending' RETURNING id`, [req.params.id, decision, comment, req.user.sub]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Нет фото, ожидающего проверки.' }); }
      await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
        [req.user.sub, 'pedestrian_path_photo_reviewed', `pedestrian:${req.params.id}`, JSON.stringify({ photoId: found.rows[0].id, decision })]);
      await client.query('COMMIT');
      res.json({ status: decision });
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch (_) { /* исходная ошибка важнее */ }
      next(error);
    } finally { if (client) client.release(); }
  });

  // Слой АСУ ОДС для карт районов. Публично GeoJSON не отдаётся: только
  // префектуре и только по её сессии. Маршрут объявлен последним, чтобы
  // «queue» и «report.xlsx» не принимались за имя района.
  router.get('/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').replace(/[^a-z0-9_-]/gi, '');
    if (!slug) return res.status(404).json({ error: 'Слой не найден.' });
    try {
      const file = new URL(`../../assets/pedestrian-paths/${slug}.geojson`, import.meta.url);
      const body = readFileSync(file, 'utf8');
      res.set('Cache-Control', 'private, no-store').type('application/geo+json').send(body);
    } catch {
      res.status(404).json({ error: 'Слой не найден.' });
    }
  });

  return router;
}
