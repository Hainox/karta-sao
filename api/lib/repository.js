import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = () => crypto.randomUUID();

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
      const id = uuid();
      const { rows } = await pool.query(
        'INSERT INTO submissions (id, district, author, created_by, original_filename, payload_sha256, change_set) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *',
        [id, changeSet.district, changeSet.author, createdBy, originalFilename, payloadSha256, JSON.stringify(changeSet)]
      );
      await pool.query('INSERT INTO audit_events (id, submission_id, actor_id, event_type, details) VALUES ($1, $2, $3, $4, $5::jsonb)', [uuid(), id, createdBy, 'submitted', JSON.stringify({ originalFilename })]);
      return rows[0];
    },
    async listSubmissions({ status, district } = {}) {
      const clauses = []; const values = [];
      if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
      if (district) { values.push(district); clauses.push(`district = $${values.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await pool.query(`SELECT id, district, author, original_filename, status, submitted_at, reviewed_at, review_comment, change_set FROM submissions ${where} ORDER BY submitted_at DESC`, values);
      return rows;
    },
    async reviewSubmission({ id, status, reviewerId, comment }) {
      const { rows } = await pool.query(
        'UPDATE submissions SET status = $2, reviewed_at = now(), reviewed_by = $3, review_comment = $4 WHERE id = $1 RETURNING *',
        [id, status, reviewerId, comment || null]
      );
      if (!rows[0]) return null;
      await pool.query('INSERT INTO audit_events (id, submission_id, actor_id, event_type, details) VALUES ($1, $2, $3, $4, $5::jsonb)', [uuid(), id, reviewerId, status, JSON.stringify({ comment: comment || null })]);
      return rows[0];
    },
    async listPhotoMarkers() {
      const { rows } = await pool.query(
        'SELECT id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at FROM photo_markers ORDER BY created_at ASC'
      );
      return rows;
    },
    async createPhotoMarker({ longitude, latitude, note, legacySourceId, createdBy }) {
      if (legacySourceId) {
        const existing = await pool.query('SELECT id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at FROM photo_markers WHERE legacy_source_id = $1', [legacySourceId]);
        if (existing.rows[0]) return { ...existing.rows[0], imported: true };
      }
      const id = uuid();
      const { rows } = await pool.query(
        'INSERT INTO photo_markers (id, longitude, latitude, note, legacy_source_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at',
        [id, longitude, latitude, note, legacySourceId, createdBy]
      );
      await pool.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), createdBy, 'photo_marker_created', JSON.stringify({ photoMarkerId: id, legacySourceId })]);
      return rows[0];
    },
    async updatePhotoMarkerNote({ id, note, actorId }) {
      const { rows } = await pool.query(
        'UPDATE photo_markers SET note = $2, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at',
        [id, note, actorId]
      );
      if (!rows[0]) return null;
      await pool.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), actorId, 'photo_marker_note_updated', JSON.stringify({ photoMarkerId: id })]);
      return rows[0];
    },
    async setPhotoMarkerPhoto({ id, bytes, mimeType, filename, actorId }) {
      const { rows } = await pool.query(
        'UPDATE photo_markers SET photo_bytes = $2, photo_mime_type = $3, photo_filename = $4, photo_size = $5, updated_by = $6, updated_at = now() WHERE id = $1 RETURNING id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, photo_bytes IS NOT NULL AS has_photo, legacy_source_id, created_at, updated_at',
        [id, bytes, mimeType, filename, bytes.length, actorId]
      );
      if (!rows[0]) return null;
      await pool.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), actorId, 'photo_marker_photo_uploaded', JSON.stringify({ photoMarkerId: id, filename, mimeType, size: bytes.length })]);
      return rows[0];
    },
    async getPhotoMarkerPhoto(id) {
      const { rows } = await pool.query('SELECT photo_bytes, photo_mime_type, photo_filename FROM photo_markers WHERE id = $1', [id]);
      return rows[0] || null;
    },
    async deletePhotoMarkerPhoto({ id, actorId }) {
      const { rows } = await pool.query(
        'UPDATE photo_markers SET photo_bytes = NULL, photo_mime_type = NULL, photo_filename = NULL, photo_size = NULL, updated_by = $2, updated_at = now() WHERE id = $1 AND photo_bytes IS NOT NULL RETURNING id, longitude, latitude, note, photo_filename, photo_mime_type, photo_size, false AS has_photo, legacy_source_id, created_at, updated_at',
        [id, actorId]
      );
      if (!rows[0]) return null;
      await pool.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), actorId, 'photo_marker_photo_deleted', JSON.stringify({ photoMarkerId: id })]);
      return rows[0];
    },
    async deletePhotoMarker({ id, actorId }) {
      const { rows } = await pool.query('DELETE FROM photo_markers WHERE id = $1 RETURNING id', [id]);
      if (!rows[0]) return null;
      await pool.query('INSERT INTO audit_events (id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)', [uuid(), actorId, 'photo_marker_deleted', JSON.stringify({ photoMarkerId: id })]);
      return rows[0];
    }
  };
}
