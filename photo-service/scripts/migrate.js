import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';

const migrationsUrl = new URL('../migrations/', import.meta.url);
const files = (await readdir(migrationsUrl)).filter((name) => name.endsWith('.sql')).sort();

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
try {
  for (const file of files) {
    await pool.query(await readFile(new URL(file, migrationsUrl), 'utf8'));
    console.log(`photo-service migration ${file} applied`);
  }
} finally {
  await pool.end();
}
