import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assessDistanceRisk, isUnusableAccuracy, photoGeoVerdict } from './src/geo.js';
import { photoServiceCookiePolicy, photoServiceDatabaseConfig } from './src/config.js';
import { createHealthHandler } from './src/health.js';
import {
  bearerToken, createSessionToken, expiredSessionCookie, hashSessionToken,
  MAX_SESSION_AGE_SECONDS, normalizeLogin, parseCookies, sessionCookie, verifyPassword,
} from './src/auth.js';
import { parseMultipart } from './src/multipart.js';
import { firstMissingUploadField } from './src/upload-fields.js';
import { createLoginThrottle } from './src/login-throttle.js';
import { clientAddress } from './src/client-address.js';
import { buildDistrictsExcel, buildExcel, buildHeadquartersExcel, buildPdf } from './src/exports.js';
import { buildHeadquartersPdf } from './src/pdf-headquarters.js';
import { loadReportRows, reportPayload } from './src/reports.js';
import {
  ARCHIVE_FILE_PATTERN, archiveDir, photoArchiveByTicket, photoArchiveJob,
  prunePhotoArchiveFiles, startPhotoArchiveJob
} from './src/photos-archive.js';
import { collectChecks, summarizeChecks } from './src/checks.js';
import { mediaRoot, readMedia, removeMedia, writeMedia } from './src/storage.js';
import { HOLDER_SELECT_SQL, objectAllowedFor } from './src/scope.js';
import { photoWithdrawVerdict, WITHDRAW_MESSAGES } from './src/withdraw.js';
import { createNotifyClient } from './src/notify.js';

const port = Number(process.env.PHOTO_SERVICE_PORT || 8788);
const REVIEW_CLAIM_LEASE_SECONDS = 30 * 60;
const basePath = (process.env.PHOTO_SERVICE_BASE_PATH || '').replace(/\/$/, '');
const notifier = createNotifyClient({ url: process.env.NOTIFY_URL, secret: process.env.NOTIFY_SECRET });
const cookiePolicy = photoServiceCookiePolicy({
  PHOTO_SERVICE_COOKIE_SAMESITE: process.env.PHOTO_SERVICE_COOKIE_SAMESITE,
  PHOTO_SERVICE_COOKIE_SECURE: process.env.PHOTO_SERVICE_COOKIE_SECURE,
  PHOTO_SERVICE_COOKIE_PATH: process.env.PHOTO_SERVICE_COOKIE_PATH || (basePath || '/photo-api'),
});
const allowedOrigins = new Set((process.env.PHOTO_SERVICE_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean));
const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 8, idleTimeoutMillis: 30000 });
const loginThrottle = createLoginThrottle();

function corsHeaders(request) {
  const origin = request?.headers?.origin;
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function sendJson(response, statusCode, body, request) {
  const headers = {
    'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...corsHeaders(request),
  };
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

function sendError(response, request, statusCode, code, message = code) {
  sendJson(response, statusCode, { error: code, message }, request);
}

function pathOf(request) {
  const raw = new URL(request.url || '/', 'http://photo-service.local').pathname;
  if (basePath && raw.startsWith(`${basePath}/`)) return raw.slice(basePath.length) || '/';
  if (basePath && raw === basePath) return '/';
  return raw;
}

/**
 * Отдаёт готовый архив файлом. Размер известен заранее, поэтому браузер показывает
 * прогресс, а докачка по Range позволяет добрать гигабайты после обрыва связи.
 */
async function serveArchiveFile(request, response, name) {
  if (!ARCHIVE_FILE_PATTERN.test(name)) return sendError(response, request, 400, 'invalid_archive_name');
  const target = join(archiveDir(process.env), name);
  let size = 0;
  try {
    size = (await stat(target)).size;
  } catch {
    return sendError(response, request, 404, 'archive_not_found');
  }
  const headers = {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    ...corsHeaders(request)
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
  const start = range && range[1] ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (range && (start >= size || start > end)) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    return response.end();
  }
  if (range) {
    response.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1
    });
    return createReadStream(target, { start, end }).on('error', () => response.destroy()).pipe(response);
  }
  response.writeHead(200, { ...headers, 'Content-Length': size });
  return createReadStream(target).on('error', () => response.destroy()).pipe(response);
}

function originAllowed(request) {
  const origin = request.headers.origin;
  return !origin || allowedOrigins.size === 0 || allowedOrigins.has(origin);
}

async function readJson(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request_too_large'), { code: 'request_too_large' });
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw Object.assign(new Error('invalid_json'), { code: 'invalid_json' });
  }
}

function sessionToken(request) {
  return parseCookies(request.headers.cookie).photo_session || bearerToken(request.headers.authorization);
}

async function currentUser(request) {
  const token = sessionToken(request);
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role, u.district, s.token_hash AS session_key
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [hashSessionToken(token)],
  );
  return result.rows[0] || null;
}

function clientKey(request) {
  return clientAddress(request.headers, request.socket.remoteAddress);
}

// District accounts only upload photos: exports, review and delete stay with the prefecture.
function requirePrefecture(response, request, user) {
  if (user.role === 'prefecture_admin') return true;
  sendError(response, request, 403, 'prefecture_role_required');
  return false;
}

function reviewOwnerKey(request, user) {
  const browserSession = String(request.headers['x-review-session'] || '').trim().slice(0, 128);
  return createHash('sha256').update(`${user.session_key}:${browserSession}`, 'utf8').digest('hex');
}

function validCoordinateFields(fields) {
  const values = ['gpsLat', 'gpsLon', 'gpsAccuracyM'].map((key) => fields[key]);
  if (values.every((value) => value === undefined || value === '')) return null;
  const [latitude, longitude, accuracy] = values.map((value) => Number(value));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw Object.assign(new Error('invalid_gps'), { code: 'invalid_gps' });
  }
  return { latitude, longitude, accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null };
}

async function handleLogin(request, response) {
  const key = clientKey(request);
  // Текст важен не меньше кода: район видел «Вход не выполнен: invalid_credentials».
  if (!loginThrottle.allowed(key)) return sendError(response, request, 429, 'too_many_login_attempts', 'Слишком много неудачных попыток — повторите через 15 минут.');
  let body;
  try { body = await readJson(request); } catch (error) { return sendError(response, request, 400, error.code || 'invalid_json'); }
  const login = normalizeLogin(body.login ?? body.email);
  const result = await pool.query('SELECT * FROM users WHERE email = $1 AND active = true', [login]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    loginThrottle.recordFailure(key);
    return sendError(response, request, 401, 'invalid_credentials', 'Неверный логин или пароль. Логин — название района.');
  }
  loginThrottle.clear(key);
  const token = createSessionToken();
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 second'))`, [hashSessionToken(token), user.id, MAX_SESSION_AGE_SECONDS]);
  response.setHeader('Set-Cookie', sessionCookie(token, cookiePolicy));
  // The token is also returned so the atlas can fall back to an explicit header on
  // browsers that refuse third-party cookies; the httpOnly cookie stays the primary path.
  return sendJson(response, 200, { token, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, district: user.district } }, request);
}

async function handleUpload(request, response, user) {
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{12,200}$/.test(idempotencyKey)) return sendError(response, request, 400, 'idempotency_key_required');
  let parsed;
  try { parsed = await parseMultipart(request); } catch (error) { return sendError(response, request, 400, error.code || 'invalid_multipart'); }
  const sourceId = parsed.fields.sourceId?.trim();
  const datasetId = parsed.fields.datasetId?.trim();
  const missingField = firstMissingUploadField({ datasetId, sourceId, performer: parsed.fields.performer });
  if (missingField) return sendError(response, request, 400, missingField.code, missingField.message);
  let gps = null;
  try { gps = validCoordinateFields(parsed.fields); } catch (error) { return sendError(response, request, 400, error.code); }
  // GPS больше не обязателен: без координат фиксация просто уходит на ручную
  // проверку. Позицию по сети (точность в сотни километров) не сохраняем — она
  // не подтверждает место, но и не мешает отправить фото.
  if (gps && isUnusableAccuracy(gps.accuracy)) gps = null;
  const objectResult = await pool.query(`SELECT object_key, reference_points, district, ${HOLDER_SELECT_SQL} FROM objects o WHERE dataset_id = $1 AND $2 = ANY(source_ids) LIMIT 1`, [datasetId, sourceId]);
  const object = objectResult.rows[0];
  if (!object) return sendError(response, request, 404, 'object_not_found');
  if (!objectAllowedFor(user, object)) return sendError(response, request, 403, 'object_out_of_scope');
  // Расстояние остаётся справочной величиной, статусом «риск» больше не помечается.
  const geo = photoGeoVerdict(assessDistanceRisk(gps, object.reference_points || []), gps?.accuracy ?? null);
  const media = await writeMedia(parsed.file.buffer, parsed.file.mimeType, mediaRoot(process.env));
  const thumbnail = parsed.thumbnail ? await writeMedia(parsed.thumbnail.buffer, parsed.thumbnail.mimeType, mediaRoot(process.env)) : null;
  const photoId = randomUUID();
  const requestHash = createHash('sha256').update(JSON.stringify({ datasetId, sourceId, fields: parsed.fields, sha256: media.sha256 })).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT photo_id, request_hash FROM idempotency_keys WHERE idempotency_key = $1 AND user_id = $2 FOR UPDATE', [idempotencyKey, user.id]);
    if (existing.rowCount) {
      // A replayed upload returns the stored verdict so the client shows the same
      // geo/review state it would have shown for the original response.
      const stored = await client.query('SELECT geo_status, distance_m, review_status FROM photos WHERE id = $1', [existing.rows[0].photo_id]);
      await client.query('ROLLBACK');
      await removeMedia(media.storageKey, mediaRoot(process.env));
      if (thumbnail) await removeMedia(thumbnail.storageKey, mediaRoot(process.env));
      if (existing.rows[0].request_hash !== requestHash) return sendError(response, request, 409, 'idempotency_key_reused');
      return sendJson(response, 200, {
        photoId: existing.rows[0].photo_id,
        duplicate: true,
        geoStatus: stored.rows[0]?.geo_status ?? null,
        distanceM: stored.rows[0]?.distance_m ?? null,
        reviewStatus: stored.rows[0]?.review_status ?? null,
      }, request);
    }
    await client.query(
      `INSERT INTO photos (id, object_key, storage_key, thumbnail_key, original_filename, mime_type, byte_size, sha256,
        performer, comment, captured_at, gps_latitude, gps_longitude, gps_accuracy_m, distance_m, geo_status,
        review_status, review_reason, uploaded_by, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending_review',$17,$18,$19)`,
      [photoId, object.object_key, media.storageKey, thumbnail?.storageKey ?? null, parsed.file.filename, parsed.file.mimeType, parsed.file.buffer.length, media.sha256,
        parsed.fields.performer.trim(), (parsed.fields.comment || '').slice(0, 2000), parsed.fields.capturedAt || null,
        gps?.latitude ?? null, gps?.longitude ?? null, gps?.accuracy ?? null, geo.distanceMeters ?? null, geo.status, geo.reviewReason, user.id, sourceId],
    );
    await client.query('INSERT INTO idempotency_keys (idempotency_key, user_id, request_hash, photo_id) VALUES ($1,$2,$3,$4)', [idempotencyKey, user.id, requestHash, photoId]);
    await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, photo_id) VALUES ($1,$2,$3,$4)', [user.id, 'photo_uploaded', object.object_key, photoId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await removeMedia(media.storageKey, mediaRoot(process.env)).catch(() => {});
    if (thumbnail) await removeMedia(thumbnail.storageKey, mediaRoot(process.env)).catch(() => {});
    throw error;
  } finally { client.release(); }
  notifier.event({
    kind: 'client',
    service: 'photo-service',
    title: 'Новое фото от района',
    fields: { Район: object.district, Объект: object.object_key, Исполнитель: parsed.fields.performer.trim(), GPS: geo.status, 'Удаление, м': geo.distanceMeters ?? '—' }
  });
  return sendJson(response, 201, { photoId, geoStatus: geo.status, distanceMeters: geo.distanceMeters ?? null, reviewStatus: 'pending_review', thumbnail: Boolean(thumbnail) }, request);
}

async function handleReviewClaim(request, response, user) {
  if (!requirePrefecture(response, request, user)) return;
  let body;
  try { body = await readJson(request); } catch (error) { return sendError(response, request, 400, error.code); }
  const objectKey = typeof body.objectKey === 'string' ? body.objectKey.trim() : '';
  if (!objectKey) return sendError(response, request, 400, 'object_key_required', 'Не указан объект для проверки.');
  const ownerKey = reviewOwnerKey(request, user);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const objectResult = await client.query(`SELECT o.object_key, o.district, ${HOLDER_SELECT_SQL} FROM objects o WHERE o.object_key = $1 FOR UPDATE`, [objectKey]);
    if (!objectResult.rowCount || !objectAllowedFor(user, objectResult.rows[0])) {
      await client.query('ROLLBACK');
      return sendError(response, request, 404, 'object_not_found');
    }
    await client.query('DELETE FROM review_claims WHERE object_key = $1 AND expires_at <= now()', [objectKey]);
    const existing = await client.query('SELECT owner_key FROM review_claims WHERE object_key = $1 FOR UPDATE', [objectKey]);
    if (existing.rowCount && existing.rows[0].owner_key !== ownerKey) {
      await client.query('ROLLBACK');
      return sendError(response, request, 409, 'review_claimed', 'Задание уже проверяет другой сотрудник.');
    }
    await client.query(`
      INSERT INTO review_claims (object_key, owner_key, claimed_at, expires_at)
      VALUES ($1, $2, now(), now() + ($3 * interval '1 second'))
      ON CONFLICT (object_key) DO UPDATE
        SET owner_key = EXCLUDED.owner_key, claimed_at = now(), expires_at = EXCLUDED.expires_at
    `, [objectKey, ownerKey, REVIEW_CLAIM_LEASE_SECONDS]);
    await client.query('COMMIT');
    return sendJson(response, 200, { objectKey, leaseSeconds: REVIEW_CLAIM_LEASE_SECONDS }, request);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function handleReview(request, response, user, photoId) {
  if (!requirePrefecture(response, request, user)) return;
  let body;
  try { body = await readJson(request); } catch (error) { return sendError(response, request, 400, error.code); }
  if (!['confirmed', 'rejected'].includes(body.status)) return sendError(response, request, 400, 'invalid_review_status');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
  if (body.status === 'rejected' && !reason) return sendError(response, request, 400, 'review_reason_required', 'Для возврата укажите причину доработки.');
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT id, object_key, source_id, review_status FROM photos WHERE id = $1 FOR UPDATE', [photoId]);
    if (!target.rowCount) { await client.query('ROLLBACK'); return sendError(response, request, 404, 'photo_not_found'); }
    const claim = await client.query('SELECT owner_key FROM review_claims WHERE object_key = $1 AND expires_at > now() FOR UPDATE', [target.rows[0].object_key]);
    if (!claim.rowCount || claim.rows[0].owner_key !== reviewOwnerKey(request, user)) {
      await client.query('ROLLBACK');
      return sendError(response, request, 409, 'review_claim_required', 'Задание уже занято другим сотрудником или срок проверки истёк.');
    }
    if (target.rows[0].review_status === 'confirmed') {
      await client.query('ROLLBACK');
      return sendError(response, request, 409, 'review_already_processed', 'Фото уже обработано другим сотрудником.');
    }
    const isReference = body.status === 'confirmed';
    if (isReference) {
      await client.query('UPDATE photos SET is_reference = false WHERE object_key = $1 AND source_id IS NOT DISTINCT FROM $2', [target.rows[0].object_key, target.rows[0].source_id]);
    }
    result = await client.query(`UPDATE photos SET review_status = $1, review_reason = $2, is_reference = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $5 RETURNING id, object_key, review_status, is_reference`, [body.status, reason || null, isReference, user.id, photoId]);
    await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, photo_id, metadata) VALUES ($1,$2,$3,$4,$5)', [user.id, `photo_${body.status}`, result.rows[0].object_key, photoId, JSON.stringify({ isReference, reason: reason || null })]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  notifier.event({
    kind: 'client',
    service: 'photo-service',
    title: body.status === 'confirmed' ? 'Префектура подтвердила фото' : 'Префектура отклонила фото',
    level: body.status === 'confirmed' ? 'info' : 'warning',
    fields: { Объект: result.rows[0].object_key, Решение: body.status, Причина: reason || '—' }
  });
  return sendJson(response, 200, result.rows[0], request);
}

async function handleDelete(request, response, user, photoId) {
  if (!requirePrefecture(response, request, user)) return;
  const result = await pool.query('SELECT id, object_key, storage_key, thumbnail_key, is_reference FROM photos WHERE id = $1', [photoId]);
  if (!result.rowCount) return sendError(response, request, 404, 'photo_not_found');
  if (result.rows[0].is_reference) return sendError(response, request, 409, 'reference_photo_cannot_be_deleted');
  await pool.query('DELETE FROM photos WHERE id = $1', [photoId]);
  await removeMedia(result.rows[0].storage_key, mediaRoot(process.env));
  if (result.rows[0].thumbnail_key) await removeMedia(result.rows[0].thumbnail_key, mediaRoot(process.env));
  await pool.query('INSERT INTO audit_log (actor_user_id, action, object_key, photo_id) VALUES ($1,$2,$3,$4)', [user.id, 'photo_deleted', result.rows[0].object_key, photoId]);
  response.writeHead(204);
  response.end();
}

/**
 * Отзыв ошибочно загруженного фото.
 *
 * Район не может удалять кадры — удаление остаётся за префектурой. Но самый
 * частый вопрос районов звучит как «как удалить фото, которое загрузили не туда»,
 * поэтому до подтверждения приёмкой район отзывает свой кадр мягко: он остаётся
 * в базе для разбора и исчезает из галереи, счётчиков и выгрузок. После
 * подтверждения отзыв запрещён — иначе подтверждённая работа пропадала бы молча.
 */
async function handleWithdraw(request, response, user, photoId) {
  const result = await pool.query(
    `SELECT p.id, p.object_key, p.source_id, p.review_status, p.uploaded_by, o.district, ${HOLDER_SELECT_SQL}
       FROM photos p JOIN objects o ON o.object_key = p.object_key
      WHERE p.id = $1`,
    [photoId],
  );
  const photo = result.rows[0];
  const verdict = photoWithdrawVerdict(photo, { canWithdraw: Boolean(photo) && objectAllowedFor(user, photo) });
  if (!verdict.ok) return sendError(response, request, verdict.status, verdict.code, verdict.message);
  if (!verdict.already) {
    const updated = await pool.query(
      `UPDATE photos SET review_status = 'withdrawn', review_reason = 'withdrawn_by_district',
              withdrawn_at = now(), withdrawn_by = $2
        WHERE id = $1 AND review_status = 'pending_review'
        RETURNING id`,
      [photoId, user.id],
    );
    // Между проверкой и обновлением приёмка могла подтвердить кадр.
    if (!updated.rowCount) {
      return sendError(response, request, 409, 'photo_not_pending', WITHDRAW_MESSAGES.photo_not_pending);
    }
    await pool.query('INSERT INTO audit_log (actor_user_id, action, object_key, photo_id) VALUES ($1,$2,$3,$4)', [user.id, 'photo_withdrawn', photo.object_key, photoId]);
    notifier.event({
      kind: 'client',
      service: 'photo-service',
      title: 'Район отозвал фото',
      level: 'warning',
      fields: { Район: photo.district, Объект: photo.object_key, Точка: photo.source_id || '—' },
    });
  }
  return sendJson(response, 200, { photoId, reviewStatus: 'withdrawn' }, request);
}

async function handler(request, response) {
  if (request.method === 'OPTIONS') {
    if (!originAllowed(request)) return sendError(response, request, 403, 'origin_not_allowed');
    response.writeHead(204, { 'Access-Control-Allow-Origin': request.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, Authorization, X-Review-Session', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', Vary: 'Origin' });
    response.end();
    return;
  }
  if (!originAllowed(request)) return sendError(response, request, 403, 'origin_not_allowed');
  const pathname = pathOf(request);
  try {
    if (pathname === '/auth/login' && request.method === 'POST') return handleLogin(request, response);
    if (pathname === '/auth/logout' && request.method === 'POST') {
      const token = sessionToken(request);
      if (token) {
        const sessionHash = hashSessionToken(token);
        await pool.query('DELETE FROM review_claims WHERE owner_key = $1', [reviewOwnerKey(request, { session_key: sessionHash })]);
        await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sessionHash]);
      }
      response.setHeader('Set-Cookie', expiredSessionCookie(cookiePolicy));
      return sendJson(response, 200, { ok: true }, request);
    }
    // Готовый архив по билету: ссылку открывает браузер, а cookie с чужого сайта
    // может не дойти. Поэтому здесь только билет, выданный вместе с задачей сборки.
    const archiveFileMatch = pathname.match(/^\/reports\/photos\.zip\/file\/([A-Za-z0-9._-]{1,80})$/);
    if (archiveFileMatch && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const job = photoArchiveByTicket(url.searchParams.get('ticket'));
      if (!job || job.name !== archiveFileMatch[1]) return sendError(response, request, 404, 'archive_not_found');
      return serveArchiveFile(request, response, archiveFileMatch[1]);
    }
    const user = await currentUser(request);
    if (!user) return sendError(response, request, 401, 'authentication_required');
    if (pathname === '/auth/me' && request.method === 'GET') return sendJson(response, 200, { user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, district: user.district } }, request);
    if (pathname === '/photos' && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const datasetId = url.searchParams.get('datasetId');
      const sourceId = url.searchParams.get('sourceId');
      if (!datasetId || !sourceId) return sendError(response, request, 400, 'dataset_source_required');
      const objectResult = await pool.query(`SELECT object_key, district, ${HOLDER_SELECT_SQL} FROM objects o WHERE dataset_id = $1 AND $2 = ANY(source_ids) LIMIT 1`, [datasetId, sourceId]);
      const object = objectResult.rows[0];
      if (!object || !objectAllowedFor(user, object)) return sendError(response, request, 404, 'object_not_found');
      // Снимок принадлежит конкретной точке: у объекта с тем же ID могут быть
      // другие точки, и чужие кадры на них показывать нельзя.
      const reviewFilter = user.role === 'prefecture_admin' ? "p.review_status <> 'withdrawn'" : "p.review_status NOT IN ('rejected', 'withdrawn')";
      const result = await pool.query(`SELECT id, storage_key, mime_type, original_filename, byte_size, performer, comment, captured_at, uploaded_at, gps_latitude, gps_longitude, gps_accuracy_m, distance_m, geo_status, review_status, review_reason, is_reference, source_id FROM photos p WHERE object_key = $1 AND source_id = $2 AND ${reviewFilter} ORDER BY uploaded_at`, [object.object_key, sourceId]);
      return sendJson(response, 200, { objectKey: object.object_key, photos: result.rows }, request);
    }
    if (pathname === '/photos' && request.method === 'POST') return handleUpload(request, response, user);
    const reviewMatch = pathname.match(/^\/photos\/([0-9a-f-]{36})\/review$/);
    if (reviewMatch && request.method === 'PATCH') return handleReview(request, response, user, reviewMatch[1]);
    const withdrawMatch = pathname.match(/^\/photos\/([0-9a-f-]{36})\/withdraw$/);
    if (withdrawMatch && request.method === 'POST') return handleWithdraw(request, response, user, withdrawMatch[1]);
    const deleteMatch = pathname.match(/^\/photos\/([0-9a-f-]{36})$/);
    if (deleteMatch && request.method === 'DELETE') return handleDelete(request, response, user, deleteMatch[1]);
    const contentMatch = pathname.match(/^\/photos\/([0-9a-f-]{36})\/content$/);
    if (contentMatch && request.method === 'GET') {
      // Доступ считается тем же правилом, что и на остальных объектных ручках:
      // учётке АвД принадлежат её объекты, объекты «ДЭУ» и объекты без района,
      // поэтому сравнение одного района отдавало ей 404 на каждом своём кадре.
      const reviewFilter = user.role === 'prefecture_admin' ? "p.review_status <> 'withdrawn'" : "p.review_status NOT IN ('rejected', 'withdrawn')";
      const result = await pool.query(`SELECT p.storage_key, p.mime_type, o.district, ${HOLDER_SELECT_SQL} FROM photos p JOIN objects o ON o.object_key = p.object_key WHERE p.id = $1 AND ${reviewFilter}`, [contentMatch[1]]);
      if (!result.rowCount || !objectAllowedFor(user, result.rows[0])) return sendError(response, request, 404, 'photo_not_found');
      // The atlas reads photo bytes through an authorised fetch, so the media response
      // needs the same CORS headers as the JSON endpoints.
      response.writeHead(200, { 'Content-Type': result.rows[0].mime_type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(request) });
      readMedia(result.rows[0].storage_key, mediaRoot(process.env)).on('error', () => { if (!response.headersSent) sendError(response, request, 404, 'media_not_found'); else response.destroy(); }).pipe(response);
      return;
    }
    if (pathname === '/objects/resolve' && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const datasetId = url.searchParams.get('datasetId');
      const sourceId = url.searchParams.get('sourceId');
      if (!datasetId || !sourceId) return sendError(response, request, 400, 'dataset_source_required');
      const result = await pool.query(`SELECT o.object_key, o.dataset_id, o.object_type, o.report_key, o.district, o.label, o.reference_points, ${HOLDER_SELECT_SQL} FROM objects o WHERE o.dataset_id = $1 AND $2 = ANY(o.source_ids)`, [datasetId, sourceId]);
      // Тот же доступ, что и на загрузке: учётка АвД работает со своими
      // объектами во всех районах, и без балансодержателя она не получала
      // зарегистрированных точек, а расстояние считалось по одной точке карты.
      const rows = result.rows
        .filter((row) => objectAllowedFor(user, row))
        .map((row) => ({
          object_key: row.object_key, dataset_id: row.dataset_id, object_type: row.object_type,
          report_key: row.report_key, district: row.district, label: row.label, reference_points: row.reference_points,
        }));
      return sendJson(response, 200, { objects: rows }, request);
    }
    if (pathname === '/review/claim' && request.method === 'POST') return handleReviewClaim(request, response, user);
    if (pathname === '/review/queue' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined, { includeRejected: true, reviewOnly: true, reviewOwner: reviewOwnerKey(request, user) });
      return sendJson(response, 200, { objects: reportPayload(rows).objects }, request);
    }
    if (pathname === '/reports/summary' && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      const payload = reportPayload(rows);
      // Проверки (дубли фото на разных объектах) отдаём отдельным блоком: риски
      // по GPS убраны как необъективный показатель, проверки к ним не относятся.
      return sendJson(response, 200, { ...payload, checks: summarizeChecks(collectChecks(payload.objects)) }, request);
    }
    if (pathname === '/reports/export.xlsx' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      const buffer = await buildExcel(rows);
      response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="sao-photo-report.xlsx"', 'Cache-Control': 'no-store', ...corsHeaders(request) });
      response.end(buffer);
      return;
    }
    if (pathname === '/reports/export-headquarters.xlsx' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      const buffer = await buildHeadquartersExcel(rows);
      response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="sao-photo-headquarters.xlsx"', 'Cache-Control': 'no-store', ...corsHeaders(request) });
      response.end(buffer);
      return;
    }
    if (pathname === '/reports/export-headquarters.pdf' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      const buffer = await buildHeadquartersPdf(rows);
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="sao-photo-headquarters.pdf"', 'Cache-Control': 'no-store', ...corsHeaders(request) });
      response.end(buffer);
      return;
    }
    if (pathname === '/reports/export-districts.xlsx' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      const buffer = await buildDistrictsExcel(rows);
      response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="sao-photo-districts.xlsx"', 'Cache-Control': 'no-store', ...corsHeaders(request) });
      response.end(buffer);
      return;
    }
    // Архив собирается в файл в фоне: двухгигабайтная сборка не должна ждать в
    // запросе, её оборвёт прокси. Ссылку на готовый файл клиент получает ниже.
    if (pathname === '/reports/photos.zip/prepare' && request.method === 'POST') {
      if (!requirePrefecture(response, request, user)) return;
      const url = new URL(request.url, 'http://photo-service.local');
      const district = url.searchParams.get('district') || undefined;
      const rows = await loadReportRows(pool, user, district);
      // Старые файлы убираем до сборки: иначе диск заполнится гигабайтами.
      await prunePhotoArchiveFiles(archiveDir(process.env));
      const job = startPhotoArchiveJob({
        rows,
        district: district || null,
        dir: archiveDir(process.env)
      });
      return sendJson(response, 202, { id: job.id, status: job.status, total: job.total }, request);
    }
    const archiveJobMatch = pathname.match(/^\/reports\/photos\.zip\/prepare\/([0-9a-f-]{36})$/);
    if (archiveJobMatch && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const job = photoArchiveJob(archiveJobMatch[1]);
      if (!job) return sendError(response, request, 404, 'archive_job_not_found');
      return sendJson(response, 200, {
        id: job.id,
        status: job.status,
        district: job.district,
        photos: job.photos,
        total: job.total,
        bytes: job.bytes,
        skipped: job.skipped,
        name: job.name,
        error: job.error,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        // Билет нужен для ссылки на файл: браузер скачивает её навигацией.
        ticket: job.status === 'ready' ? job.ticket : null
      }, request);
    }
    if (pathname === '/reports/export.pdf' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      const buffer = await buildPdf(rows);
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="sao-photo-summary.pdf"', 'Cache-Control': 'no-store', ...corsHeaders(request) });
      response.end(buffer);
      return;
    }
    // Единый отчёт по продуктивности округа за день: JSON для интерфейса,
    // Excel с диаграммой и PDF с векторными графиками — одним набором чисел.
    if (pathname === '/reports/daily' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      return sendJson(response, 200, await dailyReportFor(user, request), request);
    }
    if (pathname === '/reports/daily.xlsx' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const [{ buildDailyExcel }, report] = await Promise.all([import('./src/daily-excel.js'), dailyReportFor(user, request)]);
      const buffer = await buildDailyExcel(report, { generatedAt: new Date() });
      response.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="sao-photo-day-${report.date}.xlsx"`,
        'Cache-Control': 'no-store', ...corsHeaders(request),
      });
      response.end(buffer);
      return;
    }
    if (pathname === '/reports/daily.pdf' && request.method === 'GET') {
      if (!requirePrefecture(response, request, user)) return;
      const [{ buildDailyPdf }, report] = await Promise.all([import('./src/daily-pdf.js'), dailyReportFor(user, request)]);
      const buffer = await buildDailyPdf(report, { generatedAt: new Date() });
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="sao-photo-day-${report.date}.pdf"`,
        'Cache-Control': 'no-store', ...corsHeaders(request),
      });
      response.end(buffer);
      return;
    }
    return sendError(response, request, 404, 'not_found');
  } catch (error) {
    if (error.code === '23505') return sendError(response, request, 409, 'conflict');
    console.error('request failed:', error.message);
    notifier.event({
      kind: 'error',
      level: 'critical',
      service: 'photo-service',
      title: 'Сбой обработки запроса',
      text: error.message,
      fields: { Адрес: `${request.method} ${request.url}` }
    });
    return sendError(response, request, error.statusCode || 500, error.code || 'internal_error');
  }
}

const healthHandler = createHealthHandler({ probeDatabase: () => pool.query('SELECT 1') });
const server = createServer((request, response) => pathOf(request) === '/healthz' ? healthHandler(request, response) : handler(request, response));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
console.log(`SAO photo service listening on port ${port}`);

/**
 * Ежечасная сводка для штаба: картинка второй таблицы листа «На штаб» и текст
 * комментария уходят фотографией в тот же чат, что и остальные оповещения.
 * Отрисовка подключается лениво: сбой картинки не должен трогать API.
 */
async function sendHourlyDigest() {
  try {
    const rows = await loadReportRows(pool, { role: 'prefecture_admin' }, undefined);
    const [{ headquartersBoard }, { renderHeadquartersImage }] = await Promise.all([
      import('./src/headquarters.js'),
      import('./src/digest.js'),
    ]);
    const board = headquartersBoard(reportPayload(rows));
    const { png, caption } = renderHeadquartersImage(board, { generatedAt: new Date() });
    const result = await notifier.photo({ caption, png });
    console.log(`Сводка штаба: ${board.percent} % выполнения, доставлено ${result?.delivered ?? 0}`);
  } catch (error) {
    console.error('digest failed:', error.message);
    notifier.event({
      kind: 'error',
      level: 'warning',
      service: 'photo-service',
      title: 'Сводка штаба не отправлена',
      text: error.message
    });
  }
}

// Запуск ровно в начале каждого часа, 24 часа в сутки.
function scheduleHourlyDigest() {
  const hourMs = 60 * 60 * 1000;
  setTimeout(async () => {
    await sendHourlyDigest();
    scheduleHourlyDigest();
  }, hourMs - (Date.now() % hourMs));
}

if (String(process.env.PHOTO_SERVICE_DIGEST_ENABLED || '').toLowerCase() === 'true') {
  scheduleHourlyDigest();
  console.log('Ежечасная сводка для штаба включена');
}

// Окно дневной динамики: две недели — рабочий горизонт округа.
const DAILY_DYNAMICS_DAYS = 14;
const DAILY_DIGEST_AT = process.env.PHOTO_SERVICE_DAILY_DIGEST_AT || '19:00';

/** Числа дня считает один модуль: JSON, Excel, PDF и рассылка берут их оттуда. */
async function dailyReportFor(user, request) {
  const url = new URL(request.url, 'http://photo-service.local');
  const requested = Number(url.searchParams.get('days'));
  const days = Number.isSafeInteger(requested) && requested >= 2 ? Math.min(90, requested) : DAILY_DYNAMICS_DAYS;
  const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
  const { dailyReport } = await import('./src/daily.js');
  return dailyReport(rows, { days });
}

/**
 * Дневная рассылка: картинка динамики с текстом дня и книга Excel документом.
 * Сбой рассылки не трогает API — как и у ежечасной сводки.
 */
async function sendDailyDigest() {
  try {
    const rows = await loadReportRows(pool, { role: 'prefecture_admin' }, undefined);
    const [{ dailyReport, dailyComment }, { buildDailyExcel }, { renderDailyChartImage }] = await Promise.all([
      import('./src/daily.js'),
      import('./src/daily-excel.js'),
      import('./src/daily-chart.js'),
    ]);
    const generatedAt = new Date();
    const report = dailyReport(rows, { days: DAILY_DYNAMICS_DAYS });
    const png = renderDailyChartImage(report);
    const caption = dailyComment(report, { generatedAt }).join('\n');
    await notifier.photo({ caption, png, filename: `sao-photo-day-${report.date}.png` });
    const book = await buildDailyExcel(report, { generatedAt });
    await notifier.document({
      caption: `Единый отчёт по продуктивности округа за ${report.date} — файл с листами «День», «Динамика», «Районы дня», «Топы дня».`,
      file: book,
      filename: `sao-photo-day-${report.date}.xlsx`,
    });
    console.log(`Отчёт за день ${report.date}: загружено ${report.overall.uploaded}, подтверждено ${report.overall.closed}`);
  } catch (error) {
    console.error('daily digest failed:', error.message);
    notifier.event({
      kind: 'error',
      level: 'warning',
      service: 'photo-service',
      title: 'Дневной отчёт не отправлен',
      text: error.message,
    });
  }
}

// Запуск в заданное время по московским суткам, затем каждые сутки.
async function scheduleDailyDigest() {
  const { msUntilDailyRun } = await import('./src/daily.js');
  const wait = msUntilDailyRun(new Date(), DAILY_DIGEST_AT);
  setTimeout(async () => {
    await sendDailyDigest();
    scheduleDailyDigest();
  }, wait);
}

if (String(process.env.PHOTO_SERVICE_DAILY_DIGEST_ENABLED || '').toLowerCase() === 'true') {
  scheduleDailyDigest();
  console.log(`Дневной отчёт по продуктивности включён: ${DAILY_DIGEST_AT} МСК`);
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async (error) => { try { await pool.end(); if (error) process.exitCode = 1; } catch { process.exitCode = 1; } });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
