import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = () => crypto.randomUUID();

export async function migrate(pool) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const sql = await fs.readFile(path.join(root, '../migrations/001_initial.sql'), 'utf8');
  await pool.query(sql);
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
    }
  };
}
