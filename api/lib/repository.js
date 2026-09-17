import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = () => crypto.randomUUID();

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* preserve the original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(pool) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = path.join(root, '../migrations');
  const migrations = (await fs.readdir(migrationsDirectory)).filter((filename) => /^\d+_.+\.sql$/.test(filename)).sort();
  for (const filename of migrations) await pool.query(await fs.readFile(path.join(migrationsDirectory, filename), 'utf8'));
}

export function createRepository(pool) {
  return {
    async findUserByEmail(email) {
      const { rows } = await pool.query('SELECT id, email, password_hash, role, district FROM users WHERE lower(email) = lower($1)', [email]);
      return rows[0] || null;
    },
    async createUser({ email, passwordHash, role, district = null }) {
      const { rows } = await pool.query(
        'INSERT INTO users (id, email, password_hash, role, district) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, district',
        [uuid(), email.toLowerCase(), passwordHash, role, district]
      );
      return rows[0];
    },
    async createSubmission({ changeSet, createdBy, originalFilename, payloadSha256 }) {
      return withTransaction(pool, async (client) => {
        const id = uuid();
        const { rows } = await client.query(
          'INSERT INTO submissions (id, district, author, created_by, original_filename, payload_sha256, change_set) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *',
          [id, changeSet.district, changeSet.author, createdBy, originalFilename, payloadSha256, JSON.stringify(changeSet)]
        );
        await client.query('INSERT INTO audit_events (id, submission_id, actor_id, event_type, details) VALUES ($1, $2, $3, $4, $5::jsonb)', [uuid(), id, createdBy, 'submitted', JSON.stringify({ originalFilename })]);
        return rows[0];
      });
    },
    async listSubmissions({ status, district } = {}) {
      const clauses = []; const values = [];
      if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
      if (district) { values.push(district); clauses.push(`district = $${values.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await pool.query(`SELECT id, district, author, original_filename, payload_sha256, status, submitted_at, reviewed_at, review_comment, change_set FROM submissions ${where} ORDER BY submitted_at DESC`, values);
      return rows;
    },
    async reviewSubmission({ id, status, reviewerId, comment }) {
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          'UPDATE submissions SET status = $2, reviewed_at = now(), reviewed_by = $3, review_comment = $4 WHERE id = $1 RETURNING *',
          [id, status, reviewerId, comment || null]
        );
        if (!rows[0]) return null;
        await client.query('INSERT INTO audit_events (id, submission_id, actor_id, event_type, details) VALUES ($1, $2, $3, $4, $5::jsonb)', [uuid(), id, reviewerId, status, JSON.stringify({ comment: comment || null })]);
        return rows[0];
      });
    },
    // Отчёт по отрисовке маршрутов: разворачиваем change_set каждого набора в
    // отдельные объекты (jsonb_array_elements) и считаем их по району, статусу
    // приёмки и типу объекта. Тип читается из properties->>'change_type', а к
    // каждой строке приклеен max(submitted_at) района: по нему видно, кто давно
    // не присылал правки. Разбор объектов на маршрут/зону/точку делает
    // route-report.js — здесь только агрегация, ровно под его форму строк.
    async routeReportRows() {
      const { rows } = await pool.query(`
        WITH features AS (
          SELECT s.district, s.status, s.submitted_at,
                 feature -> 'properties' ->> 'change_type' AS change_type
            FROM submissions s
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.change_set -> 'features', '[]'::jsonb)) AS feature
        ),
        district_last AS (
          SELECT district, max(submitted_at) AS last_submitted_at FROM submissions GROUP BY district
        )
        SELECT features.district, features.status, features.change_type,
               count(*)::int AS count, district_last.last_submitted_at AS "lastSubmittedAt"
          FROM features JOIN district_last USING (district)
         GROUP BY features.district, features.status, features.change_type, district_last.last_submitted_at
         ORDER BY features.district, features.status, features.change_type
      `);
      return rows;
    },
    // Счётчик приёмки в прямом эфире: только числа, без наборов. Полная выдача
    // тянет change_set каждого набора, а счётчик опрашивает службу каждые
    // полминуты, поэтому объекты считаем длиной массива features, не разворачивая
    // его в строки. Набор считается по своему статусу, объекты — по статусу
    // набора: приёмка решает набор целиком, построчных решений в базе нет.
    async submissionStats() {
      const { rows } = await pool.query(`
        WITH counted AS (
          SELECT
            count(*)::int AS sets_total,
            count(*) FILTER (WHERE status = 'submitted')::int AS sets_submitted,
            count(*) FILTER (WHERE status = 'approved')::int AS sets_approved,
            count(*) FILTER (WHERE status = 'rejected')::int AS sets_rejected,
            coalesce(sum(feature_count), 0)::int AS objects_total,
            coalesce(sum(feature_count) FILTER (WHERE status = 'submitted'), 0)::int AS objects_submitted,
            coalesce(sum(feature_count) FILTER (WHERE status = 'approved'), 0)::int AS objects_approved,
            coalesce(sum(feature_count) FILTER (WHERE status = 'rejected'), 0)::int AS objects_rejected
          FROM submissions
          CROSS JOIN LATERAL (
            SELECT CASE
              WHEN jsonb_typeof(change_set -> 'features') = 'array'
              THEN jsonb_array_length(change_set -> 'features')
              ELSE 0
            END AS feature_count
          ) AS counted_features
        ),
        last AS (
          SELECT district, submitted_at FROM submissions ORDER BY submitted_at DESC NULLS LAST LIMIT 1
        )
        SELECT counted.*, last.district AS last_district, last.submitted_at AS last_submitted_at
          FROM counted LEFT JOIN last ON TRUE
      `);
      const row = rows[0] || {};
      return {
        sets: {
          total: row.sets_total || 0,
          submitted: row.sets_submitted || 0,
          approved: row.sets_approved || 0,
          rejected: row.sets_rejected || 0
        },
        objects: {
          total: row.objects_total || 0,
          submitted: row.objects_submitted || 0,
          approved: row.objects_approved || 0,
          rejected: row.objects_rejected || 0
        },
        lastDistrict: row.last_district || null,
        lastSubmittedAt: row.last_submitted_at || null
      };
    },
    async listPhotoMarkers() {
      const { rows } = await pool.query(
        'SELECT id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at FROM photo_markers ORDER BY created_at ASC'
      );
      return rows;
    },
    async createPhotoMarker({ longitude, latitude, note, legacySourceId, createdBy }) {
      return withTransaction(pool, async (client) => {
        const id = uuid();
        const { rows } = await client.query(
          'INSERT INTO photo_markers (id, longitude, latitude, note, legacy_source_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (legacy_source_id) DO NOTHING RETURNING id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at',
          [id, longitude, latitude, note, legacySourceId, createdBy]
        );
        if (!rows[0] && legacySourceId) {
          const existing = await client.query('SELECT id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at FROM photo_markers WHERE legacy_source_id = $1', [legacySourceId]);
          if (existing.rows[0]) return { ...existing.rows[0], imported: true };
        }
        if (!rows[0]) throw new Error('Фото-метка не была создана.');
        await client.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), createdBy, 'photo_marker_created', JSON.stringify({ photoMarkerId: id, legacySourceId })]);
        return rows[0];
      });
    },
    async updatePhotoMarkerNote({ id, note, actorId }) {
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          'UPDATE photo_markers SET note = $2, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at',
          [id, note, actorId]
        );
        if (!rows[0]) return null;
        await client.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), actorId, 'photo_marker_note_updated', JSON.stringify({ photoMarkerId: id })]);
        return rows[0];
      });
    },
    async setPhotoMarkerPhoto({ id, bytes, mimeType, filename, actorId }) {
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          'UPDATE photo_markers SET photo_bytes = $2, photo_mime_type = $3, photo_filename = $4, photo_size = $5, updated_by = $6, updated_at = now() WHERE id = $1 RETURNING id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at',
          [id, bytes, mimeType, filename, bytes.length, actorId]
        );
        if (!rows[0]) return null;
        await client.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), actorId, 'photo_marker_photo_uploaded', JSON.stringify({ photoMarkerId: id, filename, mimeType, size: bytes.length })]);
        return rows[0];
      });
    },
    async getPhotoMarkerPhoto(id) {
      const { rows } = await pool.query('SELECT photo_bytes, photo_mime_type, photo_filename FROM photo_markers WHERE id = $1', [id]);
      return rows[0] || null;
    },
    async deletePhotoMarkerPhoto({ id, actorId }) {
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          'UPDATE photo_markers SET photo_bytes = NULL, photo_mime_type = NULL, photo_filename = NULL, photo_size = NULL, updated_by = $2, updated_at = now() WHERE id = $1 AND photo_bytes IS NOT NULL RETURNING id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, false AS has_photo, legacy_source_id, created_at, updated_at',
          [id, actorId]
        );
        if (!rows[0]) return null;
        await client.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), actorId, 'photo_marker_photo_deleted', JSON.stringify({ photoMarkerId: id })]);
        return rows[0];
      });
    },
    async deletePhotoMarker({ id, actorId }) {
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query('DELETE FROM photo_markers WHERE id = $1 RETURNING id', [id]);
        if (!rows[0]) return null;
        await client.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), actorId, 'photo_marker_deleted', JSON.stringify({ photoMarkerId: id })]);
        return rows[0];
      });
    }
  };
}
