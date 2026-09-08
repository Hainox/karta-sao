import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { createRepository, migrate } from './lib/repository.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
if (!databaseUrl) throw new Error('DATABASE_URL не задан. Скопируйте .env.example в локальный .env и задайте подключение.');
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET не задан или слишком короткий.');

const pool = new Pool({ connectionString: databaseUrl, max: 10, ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined });
await migrate(pool);
const boundary = JSON.parse(await fs.readFile(path.resolve(root, '../odh-map/layers/sao_boundary_wgs84.geojson'), 'utf8'));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:8766,https://hainox.github.io').split(',').map((value) => value.trim()).filter(Boolean);
const app = createApp({ repository: createRepository(pool), boundary, jwtSecret, allowedOrigins });
const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`ODH SAO exchange API listens on ${port}`));
