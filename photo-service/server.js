import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { assessDistanceRisk } from './src/geo.js';
import { photoServiceDatabaseConfig } from './src/config.js';
import { createHealthHandler } from './src/health.js';
import {
  createSessionToken, expiredSessionCookie, hashSessionToken,
  MAX_SESSION_AGE_SECONDS, normalizeEmail, parseCookies, sessionCookie, verifyPassword,
} from './src/auth.js';
import { parseMultipart } from './src/multipart.js';
import { buildExcel, buildPdf } from './src/exports.js';
import { loadReportRows, reportPayload } from './src/reports.js';
import { mediaRoot, readMedia, removeMedia, writeMedia } from './src/storage.js';

const port = Number(process.env.PHOTO_SERVICE_PORT || 8788);
const basePath = (process.env.PHOTO_SERVICE_BASE_PATH || '').replace(/\/$/, '');
const cookieSecure = process.env.PHOTO_SERVICE_COOKIE_SECURE !== 'false';
const cookiePath = process.env.PHOTO_SERVICE_COOKIE_PATH || (basePath || '/photo-api');
const allowedOrigins = new Set((process.env.PHOTO_SERVICE_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean));
const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 8, idleTimeoutMillis: 30000 });
const loginAttempts = new Map();

function sendJson(response, statusCode, body, request) {
  const origin = request?.headers?.origin;
  const headers = {
    'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  };
  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers.Vary = 'Origin';
  }
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

async function currentUser(request) {
  const token = parseCookies(request.headers.cookie).photo_session;
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role, u.district
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [hashSessionToken(token)],
  );
  return result.rows[0] || null;
}

function loginAllowed(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = loginAttempts.get(key) || { count: 0, started: now };
  if (now - current.started > 15 * 60 * 1000) { current.count = 0; current.started = now; }
  current.count += 1;
  loginAttempts.set(key, current);
  return current.count <= 10;
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
  if (!loginAllowed(request)) return sendError(response, request, 429, 'too_many_login_attempts');
  let body;
  try { body = await readJson(request); } catch (error) { return sendError(response, request, 400, error.code || 'invalid_json'); }
  const email = normalizeEmail(body.email);
  const result = await pool.query('SELECT * FROM users WHERE email = $1 AND active = true', [email]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(body.password, user.password_hash))) return sendError(response, request, 401, 'invalid_credentials');
  const token = createSessionToken();
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 second'))`, [hashSessionToken(token), user.id, MAX_SESSION_AGE_SECONDS]);
  response.setHeader('Set-Cookie', sessionCookie(token, { secure: cookieSecure, path: cookiePath }));
  return sendJson(response, 200, { user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, district: user.district } }, request);
}

async function handleUpload(request, response, user) {
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{12,200}$/.test(idempotencyKey)) return sendError(response, request, 400, 'idempotency_key_required');
  let parsed;
  try { parsed = await parseMultipart(request); } catch (error) { return sendError(response, request, 400, error.code || 'invalid_multipart'); }
  const sourceId = parsed.fields.sourceId?.trim();
  const datasetId = parsed.fields.datasetId?.trim();
  if (!datasetId || !sourceId || !parsed.fields.performer?.trim()) return sendError(response, request, 400, 'dataset_source_performer_required');
  let gps;
  try { gps = validCoordinateFields(parsed.fields); } catch (error) { return sendError(response, request, 400, error.code); }
  if (!gps) return sendError(response, request, 400, 'gps_required');
  const objectResult = await pool.query('SELECT object_key, reference_points, district FROM objects WHERE dataset_id = $1 AND $2 = ANY(source_ids) LIMIT 1', [datasetId, sourceId]);
  const object = objectResult.rows[0];
  if (!object) return sendError(response, request, 404, 'object_not_found');
  if (user.role === 'district_editor' && object.district !== user.district) return sendError(response, request, 403, 'object_out_of_scope');
  let geo = assessDistanceRisk(gps, object.reference_points || []);
  if (gps.accuracy === null) geo = { ...geo, status: 'review', reason: 'gps_accuracy_missing' };
  else if (gps.accuracy > 5) geo = { ...geo, status: 'review', reason: 'gps_accuracy_above_5m' };
  const media = await writeMedia(parsed.file.buffer, parsed.file.mimeType, mediaRoot(process.env));
  const photoId = randomUUID();
  const requestHash = createHash('sha256').update(JSON.stringify({ datasetId, sourceId, fields: parsed.fields, sha256: media.sha256 })).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT photo_id, request_hash FROM idempotency_keys WHERE idempotency_key = $1 AND user_id = $2 FOR UPDATE', [idempotencyKey, user.id]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      await removeMedia(media.storageKey, mediaRoot(process.env));
      if (existing.rows[0].request_hash !== requestHash) return sendError(response, request, 409, 'idempotency_key_reused');
      return sendJson(response, 200, { photoId: existing.rows[0].photo_id, duplicate: true }, request);
    }
    await client.query(
      `INSERT INTO photos (id, object_key, storage_key, original_filename, mime_type, byte_size, sha256,
        performer, comment, captured_at, gps_latitude, gps_longitude, gps_accuracy_m, distance_m, geo_status,
        review_status, review_reason, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending_review',$16,$17)`,
      [photoId, object.object_key, media.storageKey, parsed.file.filename, parsed.file.mimeType, parsed.file.buffer.length, media.sha256,
        parsed.fields.performer.trim(), (parsed.fields.comment || '').slice(0, 2000), parsed.fields.capturedAt || null,
        gps?.latitude ?? null, gps?.longitude ?? null, gps?.accuracy ?? null, geo.distanceMeters ?? null, geo.status, geo.reason || null, user.id],
    );
    await client.query('INSERT INTO idempotency_keys (idempotency_key, user_id, request_hash, photo_id) VALUES ($1,$2,$3,$4)', [idempotencyKey, user.id, requestHash, photoId]);
    await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, photo_id) VALUES ($1,$2,$3,$4)', [user.id, 'photo_uploaded', object.object_key, photoId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await removeMedia(media.storageKey, mediaRoot(process.env)).catch(() => {});
    throw error;
  } finally { client.release(); }
  return sendJson(response, 201, { photoId, geoStatus: geo.status, distanceMeters: geo.distanceMeters ?? null, reviewStatus: 'pending_review' }, request);
}

async function handleReview(request, response, user, photoId) {
  if (user.role !== 'prefecture_admin') return sendError(response, request, 403, 'prefecture_role_required');
  let body;
  try { body = await readJson(request); } catch (error) { return sendError(response, request, 400, error.code); }
  if (!['confirmed', 'rejected'].includes(body.status)) return sendError(response, request, 400, 'invalid_review_status');
  const result = await pool.query(`UPDATE photos SET review_status = $1, review_reason = $2, is_reference = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $5 RETURNING id, object_key, review_status, is_reference`, [body.status, typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null, body.isReference === true, user.id, photoId]);
  if (!result.rowCount) return sendError(response, request, 404, 'photo_not_found');
  await pool.query('INSERT INTO audit_log (actor_user_id, action, object_key, photo_id, metadata) VALUES ($1,$2,$3,$4,$5)', [user.id, `photo_${body.status}`, result.rows[0].object_key, photoId, JSON.stringify({ isReference: body.isReference === true })]);
  return sendJson(response, 200, result.rows[0], request);
}

async function handleDelete(request, response, user, photoId) {
  if (user.role !== 'prefecture_admin') return sendError(response, request, 403, 'prefecture_role_required');
  const result = await pool.query('SELECT id, object_key, storage_key, is_reference FROM photos WHERE id = $1', [photoId]);
  if (!result.rowCount) return sendError(response, request, 404, 'photo_not_found');
  if (result.rows[0].is_reference) return sendError(response, request, 409, 'reference_photo_cannot_be_deleted');
  await pool.query('DELETE FROM photos WHERE id = $1', [photoId]);
  await removeMedia(result.rows[0].storage_key, mediaRoot(process.env));
  await pool.query('INSERT INTO audit_log (actor_user_id, action, object_key, photo_id) VALUES ($1,$2,$3,$4)', [user.id, 'photo_deleted', result.rows[0].object_key, photoId]);
  response.writeHead(204);
  response.end();
}

async function handler(request, response) {
  if (request.method === 'OPTIONS') {
    if (!originAllowed(request)) return sendError(response, request, 403, 'origin_not_allowed');
    response.writeHead(204, { 'Access-Control-Allow-Origin': request.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', Vary: 'Origin' });
    response.end();
    return;
  }
  if (!originAllowed(request)) return sendError(response, request, 403, 'origin_not_allowed');
  const pathname = pathOf(request);
  try {
    if (pathname === '/auth/login' && request.method === 'POST') return handleLogin(request, response);
    if (pathname === '/auth/logout' && request.method === 'POST') {
      const token = parseCookies(request.headers.cookie).photo_session;
      if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
      response.setHeader('Set-Cookie', expiredSessionCookie(cookiePath));
      return sendJson(response, 200, { ok: true }, request);
    }
    const user = await currentUser(request);
    if (!user) return sendError(response, request, 401, 'authentication_required');
    if (pathname === '/auth/me' && request.method === 'GET') return sendJson(response, 200, { user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, district: user.district } }, request);
    if (pathname === '/photos' && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const datasetId = url.searchParams.get('datasetId');
      const sourceId = url.searchParams.get('sourceId');
      if (!datasetId || !sourceId) return sendError(response, request, 400, 'dataset_source_required');
      const objectResult = await pool.query('SELECT object_key, district FROM objects WHERE dataset_id = $1 AND $2 = ANY(source_ids) LIMIT 1', [datasetId, sourceId]);
      const object = objectResult.rows[0];
      if (!object || (user.role === 'district_editor' && object.district !== user.district)) return sendError(response, request, 404, 'object_not_found');
      const result = await pool.query(`SELECT id, storage_key, mime_type, original_filename, byte_size, performer, comment, captured_at, uploaded_at, gps_latitude, gps_longitude, gps_accuracy_m, distance_m, geo_status, review_status, review_reason, is_reference FROM photos WHERE object_key = $1 AND review_status <> 'rejected' ORDER BY uploaded_at`, [object.object_key]);
      return sendJson(response, 200, { objectKey: object.object_key, photos: result.rows }, request);
    }
    if (pathname === '/photos' && request.method === 'POST') return handleUpload(request, response, user);
    const reviewMatch = pathname.match(/^\/photos\/([0-9a-f-]{36})\/review$/);
    if (reviewMatch && request.method === 'PATCH') return handleReview(request, response, user, reviewMatch[1]);
    const deleteMatch = pathname.match(/^\/photos\/([0-9a-f-]{36})$/);
    if (deleteMatch && request.method === 'DELETE') return handleDelete(request, response, user, deleteMatch[1]);
    const contentMatch = pathname.match(/^\/photos\/([0-9a-f-]{36})\/content$/);
    if (contentMatch && request.method === 'GET') {
      const result = await pool.query(`SELECT p.storage_key, p.mime_type, o.district FROM photos p JOIN objects o ON o.object_key = p.object_key WHERE p.id = $1 AND p.review_status <> 'rejected'`, [contentMatch[1]]);
      if (!result.rowCount || (user.role === 'district_editor' && result.rows[0].district !== user.district)) return sendError(response, request, 404, 'photo_not_found');
      response.writeHead(200, { 'Content-Type': result.rows[0].mime_type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      readMedia(result.rows[0].storage_key, mediaRoot(process.env)).on('error', () => { if (!response.headersSent) sendError(response, request, 404, 'media_not_found'); else response.destroy(); }).pipe(response);
      return;
    }
    if (pathname === '/objects/resolve' && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const datasetId = url.searchParams.get('datasetId');
      const sourceId = url.searchParams.get('sourceId');
      if (!datasetId || !sourceId) return sendError(response, request, 400, 'dataset_source_required');
      const result = await pool.query('SELECT object_key, dataset_id, object_type, report_key, district, label, reference_points FROM objects WHERE dataset_id = $1 AND $2 = ANY(source_ids)', [datasetId, sourceId]);
      const rows = user.role === 'district_editor' ? result.rows.filter((row) => row.district === user.district) : result.rows;
      return sendJson(response, 200, { objects: rows }, request);
    }
    if (pathname === '/reports/summary' && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      return sendJson(response, 200, reportPayload(rows), request);
    }
    if (pathname === '/reports/export.xlsx' && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      const buffer = await buildExcel(rows);
      response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="sao-photo-report.xlsx"', 'Cache-Control': 'no-store' });
      response.end(buffer);
      return;
    }
    if (pathname === '/reports/export.pdf' && request.method === 'GET') {
      const url = new URL(request.url, 'http://photo-service.local');
      const rows = await loadReportRows(pool, user, url.searchParams.get('district') || undefined);
      const buffer = await buildPdf(rows);
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="sao-photo-summary.pdf"', 'Cache-Control': 'no-store' });
      response.end(buffer);
      return;
    }
    return sendError(response, request, 404, 'not_found');
  } catch (error) {
    if (error.code === '23505') return sendError(response, request, 409, 'conflict');
    console.error('request failed:', error.message);
    return sendError(response, request, error.statusCode || 500, error.code || 'internal_error');
  }
}

const healthHandler = createHealthHandler({ probeDatabase: () => pool.query('SELECT 1') });
const server = createServer((request, response) => pathOf(request) === '/healthz' ? healthHandler(request, response) : handler(request, response));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
console.log(`SAO photo service listening on port ${port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async (error) => { try { await pool.end(); if (error) process.exitCode = 1; } catch { process.exitCode = 1; } });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
