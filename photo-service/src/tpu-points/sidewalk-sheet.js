// Отдельная Google-таблица проверки тротуаров: выгрузка двух наборов и
// возврат решений в кабинет.
//
// Наборов два, и живут они в разных местах: «odh» — кадры фотослотов ОДХ
// (каталог тестового слоя + правки префектуры + таблица avd_sidewalk_test_photos),
// «yards» — точки съёмки тротуаров у МДК (sidewalk_photo_points). Таблица
// получает одну строку на кадр ОДХ и одну строку на действующую точку дворов,
// включая точки и кадры без снимка: «нет фото» — это тоже состояние проверки.
//
// Решения таблицы адресуются парой «слот/точка + photo_id», поэтому строка,
// устаревшая после пересъёмки, не трогает новый кадр. Повторная отправка
// идемпотентна по client_id, а ошибка не молчит: результат пишется в журнал и
// возвращается таблице. Реальный отзыв — только принятого снимка, и только он
// освобождает слот; первичная приёмка pending-кадра остаётся в кабинете.
import crypto from 'node:crypto';
import express from 'express';
import { resizeJpeg } from '../image-resize.js';
import { pointState } from './district-point-photos.js';
import { sidewalkFrameRows, loadSidewalkPhotos } from './avd-sidewalk-photos.js';

export const SHEET_SETS = Object.freeze(['odh', 'yards']);
export const THUMB_MAX = 320;
const THUMB_QUALITY = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{32}$/;

/** Одна строка на действующую точку дворов: фото текущее и последний возврат. */
export const yardsSheetQuery = `SELECT p.id AS point_id, p.point_no, p.district, p.address, p.role, p.side,
  p.heading, p.longitude, p.latitude,
  f.id AS photo_id, f.status AS photo_status, f.uploaded_at, f.reviewed_at, f.review_comment,
  r.id AS rejected_photo_id, r.review_comment AS rejected_comment, r.reviewed_at AS rejected_at
  FROM sidewalk_photo_points p
  LEFT JOIN LATERAL (SELECT t.id, t.status, t.uploaded_at, t.reviewed_at, t.review_comment
    FROM sidewalk_photo_slot_photos t
    WHERE t.point_id = p.id AND t.status IN ('pending', 'accepted')
    ORDER BY t.uploaded_at DESC, t.id DESC LIMIT 1) f ON true
  LEFT JOIN LATERAL (SELECT t.id, t.review_comment, t.reviewed_at
    FROM sidewalk_photo_slot_photos t
    WHERE t.point_id = p.id AND t.status = 'rejected'
    ORDER BY t.reviewed_at DESC NULLS LAST, t.id DESC LIMIT 1) r ON true
  WHERE p.retired_at IS NULL
  ORDER BY p.district, p.point_no`;

export const SHEET_PHOTO_SQL = {
  odh: 'SELECT photo_bytes, photo_mime_type FROM avd_sidewalk_test_photos WHERE id = $1 AND frame_id = $2',
  yards: 'SELECT photo_bytes, photo_mime_type FROM sidewalk_photo_slot_photos WHERE id = $1 AND point_id = $2',
};
const PHOTO_STATUS_SQL = {
  odh: 'SELECT status FROM avd_sidewalk_test_photos WHERE id = $1 AND frame_id = $2',
  yards: 'SELECT status FROM sidewalk_photo_slot_photos WHERE id = $1 AND point_id = $2',
};
// Возврат адресован снимку: статус accepted в WHERE — защита от устаревшей
// строки таблицы. Переснятый кадр имеет новый photo_id и не пострадает.
const REVOKE_SQL = {
  odh: `UPDATE avd_sidewalk_test_photos SET status = 'rejected', review_comment = $3, reviewed_by = $4, reviewed_at = now()
    WHERE id = $1 AND frame_id = $2 AND status = 'accepted' RETURNING id`,
  yards: `UPDATE sidewalk_photo_slot_photos SET status = 'rejected', review_comment = $3, reviewed_by = $4, reviewed_at = now()
    WHERE id = $1 AND point_id = $2 AND status = 'accepted' RETURNING id`,
};
// «Проверено» не меняет снимок, но отметка в журнале должна опираться на тот
// же accepted-статус. Проверка и запись — один UPDATE, иначе между SELECT и
// UPDATE кабинет успевает вернуть снимок, и журнал врёт об успехе.
const VERIFY_SQL = {
  odh: `UPDATE sidewalk_sheet_reviews r SET applied = true, applied_at = now(), applied_by = $2
    WHERE r.client_id = $1 AND EXISTS (
      SELECT 1 FROM avd_sidewalk_test_photos p
      WHERE p.id = $3 AND p.frame_id = $4 AND p.status = 'accepted')`,
  yards: `UPDATE sidewalk_sheet_reviews r SET applied = true, applied_at = now(), applied_by = $2
    WHERE r.client_id = $1 AND EXISTS (
      SELECT 1 FROM sidewalk_photo_slot_photos p
      WHERE p.id = $3 AND p.point_id = $4 AND p.status = 'accepted')`,
};

const states = row => pointState(row);

/** Строка дворов в том же виде, что строка кадра ОДХ. */
export function yardsSheetRows(rows) {
  return rows.map((row) => {
    const state = states(row);
    return {
      point_id: row.point_id,
      point_no: row.point_no || '',
      frame: null,
      district: row.district || '',
      district_raw: row.district || '',
      address: row.address || '',
      role: row.role || '',
      side: row.side || '',
      heading: row.heading ?? null,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      no_sidewalk: false,
      photo_state: state.status,
      photo_id: state.photo?.id || null,
      uploaded_at: state.photo?.uploaded_at || null,
      reviewed_at: state.photo?.reviewed_at || null,
      review_comment: state.photo?.review_comment || '',
      rejected_at: state.rejected?.reviewed_at || null,
      rejected_comment: state.rejected?.comment || '',
      // В таблице показываем активный снимок, а если его нет — тот, что вернули:
      // район должен видеть, за что вернули точку.
      preview_photo_id: state.photo?.id || state.rejected?.id || null,
      photo_token: null,
    };
  });
}

/** Строка кадра ОДХ в том же виде, что строка дворов. */
export function odhSheetRows(sources, { edits, photos, mergePoint }) {
  return sidewalkFrameRows(sources, { edits, photos, mergePoint, isDistrict: true, includeNoSidewalk: true })
    .map((row) => {
      const state = states(row);
      return {
        point_id: row.point_id,
        point_no: row.object_id,
        frame: row.frame,
        district: row.district,
        // Служебное имя района до подмены на «АВД САО»: по нему строится
        // ссылка на карту, потому что страницы карты живут по слагам районов.
        district_raw: row.district_raw || row.district,
        address: row.street,
        role: '',
        side: '',
        heading: row.heading ?? null,
        latitude: row.latitude ?? null,
        longitude: row.longitude ?? null,
        no_sidewalk: row.no_sidewalk === true,
        photo_state: state.status,
        photo_id: state.photo?.id || null,
        uploaded_at: state.photo?.uploaded_at || null,
        reviewed_at: state.photo?.reviewed_at || null,
        review_comment: row.photo_review_comment || '',
        rejected_at: state.rejected?.reviewed_at || null,
        rejected_comment: state.rejected?.comment || '',
        preview_photo_id: state.photo?.id || state.rejected?.id || null,
        photo_token: null,
      };
    });
}

/**
 * Выдаёт ссылки на превью. Токен создаётся один раз на снимок: повторный синк
 * возвращает тот же URL, поэтому =IMAGE() не перезагружает картинку.
 * Отозванный токен не заменяется новым — ссылка должна умирать навсегда.
 */
export async function attachPhotoTokens(pool, setName, rows, { newToken = () => crypto.randomBytes(16).toString('hex') } = {}) {
  const keys = new Map();
  for (const row of rows) if (row.preview_photo_id && !keys.has(row.preview_photo_id)) keys.set(row.preview_photo_id, row.point_id);
  if (!keys.size) return rows;
  const ids = [...keys.keys()];
  const existing = await pool.query(
    'SELECT photo_id FROM sidewalk_sheet_tokens WHERE set_name = $1 AND photo_id = ANY($2::uuid[])', [setName, ids]);
  const known = new Set(existing.rows.map(row => row.photo_id));
  const missing = ids.filter(id => !known.has(id));
  if (missing.length) {
    await pool.query(`INSERT INTO sidewalk_sheet_tokens (token, set_name, photo_id, object_key)
      SELECT token, $2, photo_id, object_key FROM unnest($1::text[], $3::uuid[], $4::text[]) AS source(token, photo_id, object_key)
      ON CONFLICT (set_name, photo_id) DO NOTHING`,
    [missing.map(() => newToken()), setName, missing, missing.map(id => keys.get(id))]);
  }
  const tokens = await pool.query(
    `SELECT photo_id, token FROM sidewalk_sheet_tokens
     WHERE set_name = $1 AND photo_id = ANY($2::uuid[]) AND revoked_at IS NULL`, [setName, ids]);
  const byPhoto = new Map(tokens.rows.map(row => [row.photo_id, row.token]));
  return rows.map(row => ({ ...row, photo_token: byPhoto.get(row.preview_photo_id) || null }));
}

/** Проверка пачки решений из таблицы: до записи, чтобы ошибка была адресной. */
export function validateSheetDecisions(body, setName) {
  if (!SHEET_SETS.includes(setName)) return { error: 'Укажите набор: odh или yards.' };
  const list = Array.isArray(body?.decisions) ? body.decisions.slice(0, 100) : [];
  if (!list.length) return { error: 'Нет решений.' };
  const decisions = [];
  for (const item of list) {
    const clientId = String(item?.client_id || '').slice(0, 80);
    if (!clientId) return { error: 'У решения нет client_id.' };
    const pointId = String(item?.point_id || '').slice(0, 80);
    const photoId = item?.photo_id ? String(item.photo_id) : '';
    const decision = String(item?.decision || '');
    if (!pointId) return { error: `Решение ${clientId}: не указана точка или фотослот.` };
    if (!['verified', 'rework'].includes(decision)) return { error: `Решение ${clientId}: неизвестное действие.` };
    if (!UUID.test(photoId)) return { error: `Решение ${clientId}: нужен photo_id снимка.` };
    const reason = String(item?.reason || '').slice(0, 2000) || null;
    const comment = String(item?.comment || '').slice(0, 2000) || null;
    if (decision === 'rework' && !reason && !comment) return { error: `Решение ${clientId}: укажите причину возврата.` };
    const reviewedAt = item?.reviewed_at ? new Date(item.reviewed_at) : new Date();
    if (Number.isNaN(reviewedAt.getTime())) return { error: `Решение ${clientId}: некорректное время решения.` };
    decisions.push({
      client_id: clientId,
      point_id: pointId,
      photo_id: photoId,
      decision,
      reason,
      comment,
      reviewed_by: String(item?.reviewed_by || 'sheet').slice(0, 200) || 'sheet',
      reviewed_at: reviewedAt,
    });
  }
  return { decisions };
}

/**
 * Применяет одно решение. Журнал и отзыв — одна транзакция: если отзыв упал,
 * ошибка тоже сохранится, и таблица не будет присылать строку каждые 10 минут.
 */
export async function applySheetDecision(pool, setName, item, actorId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`INSERT INTO sidewalk_sheet_reviews
      (client_id, set_name, point_id, photo_id, decision, reason, comment, reviewed_by, reviewed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (client_id) DO NOTHING RETURNING id`,
    [item.client_id, setName, item.point_id, item.photo_id, item.decision, item.reason, item.comment, item.reviewed_by, item.reviewed_at]);
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      const { rows } = await pool.query('SELECT applied, error FROM sidewalk_sheet_reviews WHERE client_id = $1', [item.client_id]);
      return { client_id: item.client_id, applied: rows[0]?.applied === true, duplicate: true,
        ...(rows[0]?.error ? { error: rows[0].error } : {}) };
    }
    let error = null;
    if (item.decision === 'rework') {
      // Район видит review_comment: сначала обязательная причина, затем
      // необязательный комментарий. Колонка кабинета ограничена 2000 символами.
      const comment = [item.reason, item.comment].filter(Boolean).join(' · ').slice(0, 2000)
        || 'Возврат из таблицы';
      const revoked = await client.query(REVOKE_SQL[setName], [item.photo_id, item.point_id, comment, actorId]);
      if (revoked.rowCount) {
        await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
          [actorId, 'sidewalk_sheet_photo_revoked', `sidewalk:${item.point_id}`,
            JSON.stringify({ set: setName, photoId: item.photo_id, reason: item.reason, comment: item.comment, source: 'sheet', clientId: item.client_id })]);
        await client.query('UPDATE sidewalk_sheet_reviews SET applied = true, applied_at = now(), applied_by = $2 WHERE client_id = $1',
          [item.client_id, actorId]);
      } else {
        // Либо снимок уже не accepted (переснят, возвращён в кабинете), либо
        // строка указывает не на тот слот — второй случай тоже виден человеку.
        const { rows } = await client.query(PHOTO_STATUS_SQL[setName], [item.photo_id, item.point_id]);
        error = rows[0] ? 'photo_not_accepted' : 'photo_not_found';
      }
    } else {
      const verified = await client.query(VERIFY_SQL[setName], [item.client_id, actorId, item.photo_id, item.point_id]);
      if (!verified.rowCount) {
        const { rows } = await client.query(PHOTO_STATUS_SQL[setName], [item.photo_id, item.point_id]);
        error = rows[0] ? 'photo_not_accepted' : 'photo_not_found';
      }
    }
    if (error) await client.query('UPDATE sidewalk_sheet_reviews SET error = $2 WHERE client_id = $1', [item.client_id, error]);
    await client.query('COMMIT');
    return { client_id: item.client_id, applied: !error, ...(error ? { error } : {}) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* исходная ошибка важнее */ }
    throw error;
  } finally {
    client.release();
  }
}

export function createSidewalkSheetRouter({ pool, authenticate, loadCatalog, loadEdits, mergePoint }) {
  const router = express.Router();
  // Превью по токену — единственный маршрут без сессии: =IMAGE() не умеет
  // заголовок Authorization. Токен неугадываемый, отзываемый, только 320 px.
  router.get('/photo-thumb/:token', async (req, res, next) => {
    try {
      const token = String(req.params.token || '').replace(/\.jpg$/i, '');
      if (!TOKEN.test(token)) return res.status(404).json({ error: 'Фото не найдено.' });
      const { rows } = await pool.query('SELECT set_name, photo_id, object_key FROM sidewalk_sheet_tokens WHERE token = $1 AND revoked_at IS NULL', [token]);
      if (!rows[0]) return res.status(404).json({ error: 'Фото не найдено.' });
      const { set_name: setName, photo_id: photoId, object_key: objectKey } = rows[0];
      // Токен привязан к живому снимку: удалённый снимок не должен оставаться
      // доступным из кэша превью.
      const source = await pool.query(PHOTO_STATUS_SQL[setName], [photoId, objectKey]);
      if (!source.rows[0]) return res.status(404).json({ error: 'Фото не найдено.' });
      const cached = await pool.query('SELECT photo_bytes, photo_mime_type FROM sidewalk_sheet_thumbs WHERE photo_id = $1', [photoId]);
      let thumb = cached.rows[0];
      if (!thumb) {
        const photo = await pool.query(SHEET_PHOTO_SQL[setName], [photoId, objectKey]);
        if (!photo.rows[0]) return res.status(404).json({ error: 'Фото не найдено.' });
        let preview;
        try {
          preview = await resizeJpeg(photo.rows[0].photo_bytes, { max: THUMB_MAX, quality: THUMB_QUALITY });
        } catch {
          // Битый файл не должен отдавать наружу оригинал: в таблице пусто.
          return res.status(404).json({ error: 'Превью недоступно.' });
        }
        await pool.query(`INSERT INTO sidewalk_sheet_thumbs (photo_id, photo_bytes, photo_mime_type, photo_size, width, height)
          VALUES ($1,$2,'image/jpeg',$3,$4,$5) ON CONFLICT (photo_id) DO NOTHING`,
        [photoId, preview.bytes, preview.bytes.length, preview.width, preview.height]);
        thumb = { photo_bytes: preview.bytes, photo_mime_type: 'image/jpeg' };
      }
      res.set('Cache-Control', 'public, max-age=86400, immutable').set('X-Robots-Tag', 'noindex')
        .type(thumb.photo_mime_type).send(thumb.photo_bytes);
    } catch (error) { next(error); }
  });

  router.use(authenticate, (req, res, next) => req.user.role === 'prefecture_admin'
    ? next() : res.status(403).json({ error: 'Таблица проверки тротуаров доступна только префектуре.' }));

  router.get('/sheet.json', async (req, res, next) => {
    try {
      const setName = String(req.query.set || '');
      if (!SHEET_SETS.includes(setName)) return res.status(422).json({ error: 'Укажите набор: odh или yards.' });
      let rows;
      if (setName === 'odh') {
        const [catalog, edits, photos] = await Promise.all([loadCatalog(), loadEdits(), loadSidewalkPhotos(pool)]);
        rows = odhSheetRows([...catalog.districtPoints, ...catalog.avdPoints], { edits, photos, mergePoint });
      } else {
        rows = yardsSheetRows((await pool.query(yardsSheetQuery)).rows);
      }
      res.set('Cache-Control', 'private, no-store').json({
        set: setName, generated_at: new Date().toISOString(), rows: await attachPhotoTokens(pool, setName, rows),
      });
    } catch (error) { next(error); }
  });

  router.post('/sheet-decisions', async (req, res, next) => {
    try {
      const setName = String(req.body?.set || req.query.set || '');
      const { decisions, error } = validateSheetDecisions(req.body, setName);
      if (error) return res.status(422).json({ error });
      const results = [];
      for (const item of decisions) results.push(await applySheetDecision(pool, setName, item, req.user.sub));
      res.json({
        applied: results.filter(row => row.applied).length,
        skipped: results.filter(row => !row.applied).length,
        results,
      });
    } catch (error) { next(error); }
  });
  return router;
}
