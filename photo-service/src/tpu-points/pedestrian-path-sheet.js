// Google-таблица проверки пешеходных дорожек: срез для Apps Script,
// превью по токену и возврат решений в кабинет.
//
// Таблица — вторая поверхность приёмки, а не копия кабинета: в ней можно
// принять ожидающий кадр, отметить уже принятый или вернуть его на доработку.
// Возврат адресуется photo_id: устаревшая строка не тронет переснятый кадр.
import crypto from 'node:crypto';
import express from 'express';
import { resizeJpeg } from '../image-resize.js';
import { pointState } from './district-point-photos.js';
import { PATH_QUEUE_SQL } from './pedestrian-paths.js';

export const PATH_THUMB_MAX = 320;
export const PATH_DECISIONS = Object.freeze(['accepted', 'verified', 'rework']);

const THUMB_QUALITY = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{32}$/;
const INCREMENTAL_LIMIT = 500;
const DISTRICT_SLUGS = Object.freeze({
  'Аэропорт': 'aeroport', 'Беговой': 'begovoy', 'Бескудниковский': 'beskudnikovskiy',
  'Войковский': 'voykovskiy', 'Восточное Дегунино': 'vostochnoe-degunino',
  'Головинский': 'golovinskiy', 'Дмитровский': 'dmitrovskiy',
  'Западное Дегунино': 'zapadnoe-degunino', 'Коптево': 'koptevo',
  'Левобережный': 'levoberezhnyy', 'Молжаниновский': 'molzhaninovskiy',
  'Савеловский': 'savelovskiy', 'Сокол': 'sokol', 'Тимирязевский': 'timiryazevskiy',
  'Ховрино': 'hovrino', 'Хорошевский': 'horoshevskiy',
});

/** Строка таблицы: одна точка, активный кадр и последний возврат. */
export function pathSheetRows(rows) {
  return rows.map((row) => {
    const state = pointState(row);
    const photo = state.photo || null;
    const rejected = state.rejected || null;
    const preview = photo || rejected;
    const slug = DISTRICT_SLUGS[row.district];
    const mapUrl = slug
      ? `https://hainox.github.io/karta-sao/districts/${slug}.html?path=${encodeURIComponent(String(row.path_id))}`
        + `&lat=${Number(row.latitude).toFixed(6)}&lng=${Number(row.longitude).toFixed(6)}`
      : '';
    return {
      point_id: row.point_id,
      point_no: row.point_no,
      path_id: row.path_id,
      ordinal: row.ordinal,
      district: row.district,
      address: row.address || '',
      route_m: row.route_m,
      area: row.area,
      coating: row.coating || '',
      longitude: row.longitude,
      latitude: row.latitude,
      updated_at: row.updated_at || null,
      map_url: mapUrl,
      photo_state: state.status,
      photo_id: photo?.id || null,
      uploaded_at: photo?.uploaded_at || rejected?.uploaded_at || null,
      reviewed_at: photo?.reviewed_at || rejected?.reviewed_at || null,
      review_comment: photo?.review_comment || '',
      rejected_comment: rejected?.comment || '',
      rejected_at: rejected?.reviewed_at || null,
      preview_photo_id: preview?.id || null,
      preview_status: preview?.status || null,
      photo_token: null,
    };
  });
}

/**
 * Выдаёт ссылки на превью. Токен создаётся один раз на снимок: повторный синк
 * возвращает тот же URL, поэтому =IMAGE() не перезагружает картинку.
 * Возвращённый кадр остаётся доступен: таблица должна видеть, за что вернули.
 */
export async function attachPathPhotoTokens(pool, rows, { newToken = () => crypto.randomBytes(16).toString('hex') } = {}) {
  const byPhoto = new Map();
  for (const row of rows) if (row.preview_photo_id && !byPhoto.has(row.preview_photo_id)) byPhoto.set(row.preview_photo_id, row.point_id);
  if (!byPhoto.size) return rows;
  const ids = [...byPhoto.keys()];
  const existing = await pool.query(
    'SELECT photo_id, token FROM pedestrian_path_sheet_tokens WHERE photo_id = ANY($1::uuid[]) AND revoked_at IS NULL', [ids]);
  const known = new Map(existing.rows.map((row) => [row.photo_id, row.token]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    await pool.query(`INSERT INTO pedestrian_path_sheet_tokens (token, photo_id, point_id)
      SELECT token, photo_id, point_id FROM unnest($1::text[], $2::uuid[], $3::uuid[]) AS source(token, photo_id, point_id)
      ON CONFLICT (photo_id) DO NOTHING`,
    [missing.map(() => newToken()), missing, missing.map((id) => byPhoto.get(id))]);
    const created = await pool.query(
      'SELECT photo_id, token FROM pedestrian_path_sheet_tokens WHERE photo_id = ANY($1::uuid[]) AND revoked_at IS NULL', [missing]);
    created.rows.forEach((row) => known.set(row.photo_id, row.token));
  }
  return rows.map((row) => ({ ...row, photo_token: row.preview_photo_id ? known.get(row.preview_photo_id) || null : null }));
}

/** Проверка пачки решений до записи, чтобы ошибка была адресной. */
export function validatePathSheetDecisions(body) {
  const list = Array.isArray(body?.decisions) ? body.decisions.slice(0, 100) : [];
  if (!list.length) return { error: 'Нет решений.' };
  const decisions = [];
  for (const item of list) {
    const clientId = String(item?.client_id || '').slice(0, 80);
    if (!clientId) return { error: 'У решения нет client_id.' };
    const pointId = String(item?.point_id || '');
    const photoId = String(item?.photo_id || '');
    const decision = String(item?.decision || '');
    if (!UUID.test(pointId)) return { error: `Решение ${clientId}: неверный point_id.` };
    if (!UUID.test(photoId)) return { error: `Решение ${clientId}: нужен photo_id снимка.` };
    if (!PATH_DECISIONS.includes(decision)) return { error: `Решение ${clientId}: неизвестное действие.` };
    const reason = String(item?.reason || '').slice(0, 2000) || null;
    const comment = String(item?.comment || '').slice(0, 2000) || null;
    if (decision === 'rework' && !reason && !comment) return { error: `Решение ${clientId}: укажите причину возврата.` };
    const reviewedAt = item?.reviewed_at ? new Date(item.reviewed_at) : new Date();
    if (Number.isNaN(reviewedAt.getTime())) return { error: `Решение ${clientId}: некорректное время решения.` };
    decisions.push({
      client_id: clientId, point_id: pointId, photo_id: photoId, decision, reason, comment,
      reviewed_by: String(item?.reviewed_by || 'sheet').slice(0, 200) || 'sheet', reviewed_at: reviewedAt,
    });
  }
  return { decisions };
}

const photoStatus = async (client, photoId, pointId) => {
  const { rows } = await client.query('SELECT status FROM pedestrian_path_photos WHERE id = $1 AND point_id = $2', [photoId, pointId]);
  return rows[0]?.status || null;
};

/**
 * Применяет одно решение. Журнал и изменение снимка — одна транзакция:
 * упавший возврат не оставит строку «применено».
 */
export async function applyPathSheetDecision(pool, item, actorId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`INSERT INTO pedestrian_path_sheet_reviews
      (client_id, point_id, photo_id, decision, reason, comment, reviewed_by, reviewed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (client_id) DO NOTHING RETURNING id`,
    [item.client_id, item.point_id, item.photo_id, item.decision, item.reason, item.comment, item.reviewed_by, item.reviewed_at]);
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      const { rows } = await pool.query('SELECT applied, error FROM pedestrian_path_sheet_reviews WHERE client_id = $1', [item.client_id]);
      return { client_id: item.client_id, applied: rows[0]?.applied === true, duplicate: true,
        ...(rows[0]?.error ? { error: rows[0].error } : {}) };
    }
    let error = null;
    let status = null;
    if (item.decision === 'accepted') {
      const updated = await client.query(`UPDATE pedestrian_path_photos SET status = 'accepted', review_comment = $3,
        reviewed_by = $4, reviewed_at = now()
        WHERE id = $1 AND point_id = $2 AND status = 'pending' RETURNING id`, [item.photo_id, item.point_id, item.comment || '', actorId]);
      if (updated.rowCount) status = 'accepted';
      else {
        const current = await photoStatus(client, item.photo_id, item.point_id);
        error = current ? 'photo_not_pending' : 'photo_not_found';
      }
    } else if (item.decision === 'rework') {
      // Район видит причину, затем необязательный комментарий — как в кабинете.
      const comment = [item.reason, item.comment].filter(Boolean).join(' · ').slice(0, 2000) || 'Возврат из таблицы';
      const updated = await client.query(`UPDATE pedestrian_path_photos SET status = 'rejected', review_comment = $3,
        reviewed_by = $4, reviewed_at = now()
        WHERE id = $1 AND point_id = $2 AND status IN ('pending', 'accepted') RETURNING id`, [item.photo_id, item.point_id, comment, actorId]);
      if (updated.rowCount) status = 'rejected';
      else {
        const current = await photoStatus(client, item.photo_id, item.point_id);
        error = current ? 'photo_not_active' : 'photo_not_found';
      }
    } else {
      // «Проверено» не меняет снимок: это отметка сверки уже принятого кадра.
      const current = await photoStatus(client, item.photo_id, item.point_id);
      if (!current) error = 'photo_not_found';
      else if (current !== 'accepted') error = 'photo_not_accepted';
    }
    if (error) await client.query('UPDATE pedestrian_path_sheet_reviews SET error = $2 WHERE client_id = $1', [item.client_id, error]);
    else {
      await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
        [actorId, `pedestrian_sheet_${item.decision}`, `pedestrian:${item.point_id}`,
          JSON.stringify({ photoId: item.photo_id, decision: item.decision, reason: item.reason, comment: item.comment, source: 'sheet', clientId: item.client_id })]);
      await client.query(`UPDATE pedestrian_path_sheet_reviews SET applied = true, applied_at = now(), applied_by = $2
        WHERE client_id = $1`, [item.client_id, actorId]);
    }
    await client.query('COMMIT');
    return { client_id: item.client_id, applied: !error, ...(status ? { status } : {}), ...(error ? { error } : {}) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* исходная ошибка важнее */ }
    throw error;
  } finally {
    client.release();
  }
}

export function createPedestrianPathSheetRouter({ pool, authenticate }) {
  const router = express.Router();
  // Превью по токену — единственный маршрут без сессии: =IMAGE() не умеет
  // заголовок Authorization. Токен неугадываемый, отзываемый, только 320 px.
  router.get('/photo-thumb/:token', async (req, res, next) => {
    try {
      const token = String(req.params.token || '').replace(/\.jpg$/i, '');
      if (!TOKEN.test(token)) return res.status(404).json({ error: 'Фото не найдено.' });
      const { rows } = await pool.query(
        'SELECT photo_id, point_id FROM pedestrian_path_sheet_tokens WHERE token = $1 AND revoked_at IS NULL', [token]);
      if (!rows[0]) return res.status(404).json({ error: 'Фото не найдено.' });
      const { photo_id: photoId, point_id: pointId } = rows[0];
      const source = await pool.query('SELECT 1 FROM pedestrian_path_photos WHERE id = $1 AND point_id = $2', [photoId, pointId]);
      if (!source.rows[0]) return res.status(404).json({ error: 'Фото не найдено.' });
      const cached = await pool.query('SELECT photo_bytes, photo_mime_type FROM pedestrian_path_sheet_thumbs WHERE photo_id = $1', [photoId]);
      let thumb = cached.rows[0];
      if (!thumb) {
        const photo = await pool.query('SELECT photo_bytes FROM pedestrian_path_photos WHERE id = $1', [photoId]);
        if (!photo.rows[0]) return res.status(404).json({ error: 'Фото не найдено.' });
        let preview;
        try {
          preview = await resizeJpeg(photo.rows[0].photo_bytes, { max: PATH_THUMB_MAX, quality: THUMB_QUALITY });
        } catch {
          // Битый файл не должен отдавать наружу оригинал: в таблице пусто.
          return res.status(404).json({ error: 'Превью недоступно.' });
        }
        await pool.query(`INSERT INTO pedestrian_path_sheet_thumbs (photo_id, photo_bytes, photo_mime_type, photo_size, width, height)
          VALUES ($1,$2,'image/jpeg',$3,$4,$5) ON CONFLICT (photo_id) DO NOTHING`,
        [photoId, preview.bytes, preview.bytes.length, preview.width, preview.height]);
        thumb = { photo_bytes: preview.bytes, photo_mime_type: 'image/jpeg' };
      }
      res.set('Cache-Control', 'public, max-age=86400, immutable').set('X-Robots-Tag', 'noindex')
        .type(thumb.photo_mime_type).send(thumb.photo_bytes);
    } catch (error) { next(error); }
  });

  router.use(authenticate, (req, res, next) => req.user.role === 'prefecture_admin'
    ? next() : res.status(403).json({ error: 'Таблица проверки дорожек доступна только префектуре.' }));

  router.get('/sheet.json', async (req, res, next) => {
    try {
      // Время снимаем до запроса: всё, что изменится после него, попадёт
      // в следующий срез. Минута перекрытия спасает от расхождения часов.
      const generatedAt = new Date();
      const rawSince = String(req.query.since || '');
      const since = rawSince ? new Date(rawSince) : null;
      const validSince = since && !Number.isNaN(since.getTime()) ? since : null;
      const all = pathSheetRows((await pool.query(PATH_QUEUE_SQL)).rows);
      let rows = all;
      let full = true;
      let removed = [];
      if (validSince) {
        const threshold = validSince.getTime() - 60000;
        const changed = all.filter((row) => [
          row.updated_at, row.uploaded_at, row.reviewed_at, row.rejected_at,
        ].filter(Boolean).some((value) => new Date(value).getTime() > threshold));
        full = changed.length > INCREMENTAL_LIMIT;
        if (!full) {
          rows = changed;
          const retired = await pool.query('SELECT id FROM pedestrian_path_points WHERE retired_at > $1', [validSince]);
          removed = retired.rows.map((row) => row.id);
          if (removed.length) full = true;
        }
        if (full) rows = all;
      }
      res.set('Cache-Control', 'private, no-store').json({
        generated_at: generatedAt.toISOString(),
        full,
        rows: await attachPathPhotoTokens(pool, rows),
        removed: full ? [] : removed,
      });
    } catch (error) { next(error); }
  });

  router.post('/sheet-decisions', async (req, res, next) => {
    try {
      const { decisions, error } = validatePathSheetDecisions(req.body);
      if (error) return res.status(422).json({ error });
      const results = [];
      for (const item of decisions) results.push(await applyPathSheetDecision(pool, item, req.user.sub));
      res.json({ results });
    } catch (error) { next(error); }
  });

  return router;
}
