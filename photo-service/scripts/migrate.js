import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
try {
  const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('photo-service migration 001_initial applied');
} finally {
  await pool.end();
}
