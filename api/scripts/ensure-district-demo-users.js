import crypto from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from '../lib/auth.js';
import { migrate } from '../lib/repository.js';
import { DISTRICTS } from '../lib/validation.js';

const password = process.env.DISTRICT_DEMO_PASSWORD;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан.');
if (typeof password !== 'string' || password.length < 8) throw new Error('DISTRICT_DEMO_PASSWORD должен содержать не менее 8 символов.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool);
  const passwordHash = await hashPassword(password);
  for (const district of [...DISTRICTS].sort((first, second) => first.localeCompare(second, 'ru'))) {
    const { rows } = await pool.query(
      `INSERT INTO users (id, email, password_hash, role, district)
       VALUES ($1, $2, $3, 'district_editor', $4)
       ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, district = EXCLUDED.district
       RETURNING email, role, district`,
      [crypto.randomUUID(), district.toLowerCase(), passwordHash, district]
    );
    console.log(`${rows[0].district}: ${rows[0].email}`);
  }
} finally {
  await pool.end();
}
