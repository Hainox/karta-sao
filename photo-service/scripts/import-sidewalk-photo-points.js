// Импорт точек съёмки тротуаров из районных слоёв атласа
// (districts/layers/<район>/sidewalk_shoot.geojson) в sidewalk_photo_points.
// Перезапуск безопасен: точка с уже известным номером пропускается, поэтому
// правки префектуры (перенос, направление, удаление) не перетираются.
// По умолчанию — сухой прогон.
//
//   node scripts/import-sidewalk-photo-points.js --source=/sources/districts/layers [--apply]
import crypto from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { DISTRICTS } from '../src/tpu-points/validation.js';

/** Строки для вставки из одного слоя района; ошибочные точки — в problems. */
export function sidewalkRowsFromLayer(data, problems = []) {
  const rows = [];
  for (const feature of data?.features || []) {
    const p = feature.properties || {};
    const [longitude, latitude] = feature.geometry?.coordinates || [];
    const heading = Number(p.azimuth);
    if (!p.point_no || !DISTRICTS.has(p.district) || ![longitude, latitude].every(Number.isFinite)
      || !Number.isInteger(heading) || heading < 0 || heading > 359) {
      problems.push(`${p.point_no || '?'}: неполные данные точки`);
      continue;
    }
    rows.push({
      point_no: String(p.point_no), district: p.district, address: String(p.address || '').slice(0, 300),
      unom: String(p.unom ?? ''), role: String(p.role || ''), side: String(p.side || ''),
      also_covers: String(p.also_covers || '').slice(0, 2000), longitude, latitude, heading,
      status: String(p.status || 'черновик'),
    });
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const sourceArg = args.find((a) => a.startsWith('--source='));
  if (!sourceArg) {
    console.error('Usage: node scripts/import-sidewalk-photo-points.js --source=/path/to/districts/layers [--apply]');
    process.exit(2);
  }
  const root = sourceArg.slice('--source='.length);
  const problems = [];
  const rows = [];
  for (const slug of readdirSync(root).sort()) {
    const file = join(root, slug, 'sidewalk_shoot.geojson');
    if (existsSync(file)) rows.push(...sidewalkRowsFromLayer(JSON.parse(readFileSync(file, 'utf8')), problems));
  }
  const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
  try {
    const known = new Set((await pool.query('SELECT point_no FROM sidewalk_photo_points')).rows.map((r) => r.point_no));
    const fresh = rows.filter((r) => !known.has(r.point_no));
    console.log(`В слоях точек: ${rows.length}; уже в базе: ${rows.length - fresh.length}; новых: ${fresh.length}; с ошибками: ${problems.length}`);
    problems.slice(0, 20).forEach((line) => console.log('  ' + line));
    if (!apply) { console.log('Сухой прогон: база не изменена. Для записи добавьте --apply.'); return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of fresh) {
        await client.query(`INSERT INTO sidewalk_photo_points
          (id, point_no, district, address, unom, role, side, also_covers, longitude, latitude, heading, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (point_no) DO NOTHING`,
        [crypto.randomUUID(), r.point_no, r.district, r.address, r.unom, r.role, r.side, r.also_covers, r.longitude, r.latitude, r.heading, r.status]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    console.log(`Записано точек: ${fresh.length}.`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
