// Импорт точек съёмки пешеходных дорожек из points.geojson (генератор —
// projects/pedestrian-paths/work/prepare_layer.py). По умолчанию сухой прогон.
// Повторный запуск безопасен: точка с тем же point_no обновляет координаты и
// адрес, но сохраняет id и номер. Исчезнувшие точки снимаются только если у них
// нет фото — иначе они остаются в кабинете, чтобы не потерять историю.
//
//   node scripts/import-pedestrian-path-points.js --source=assets/pedestrian-paths/points.geojson [--apply]
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const sourceArg = args.find((item) => item.startsWith('--source='));
if (args.some((item) => item !== '--apply' && !item.startsWith('--source='))
  || args.filter((item) => item.startsWith('--source=')).length > 1) {
  throw new Error('Допустимы --apply и --source=/path/to/points.geojson');
}
const source = resolve(sourceArg ? sourceArg.slice('--source='.length) : 'assets/pedestrian-paths/points.geojson');
const data = JSON.parse(readFileSync(source, 'utf8'));
const rows = [];
const problems = [];
for (const feature of data.features || []) {
  const p = feature.properties || {};
  const [longitude, latitude] = feature.geometry?.coordinates || [];
  if (!p.point_no || !p.district || !Number.isFinite(longitude) || !Number.isFinite(latitude)
    || !Number.isInteger(p.ordinal) || p.ordinal < 1 || !p.path_id) {
    problems.push(`${p.point_no || '?'}: неполные данные точки`);
    continue;
  }
  rows.push({
    point_no: String(p.point_no).slice(0, 40),
    path_id: String(p.path_id),
    ogh_id: p.ogh_id == null ? null : String(p.ogh_id),
    ordinal: p.ordinal,
    district: String(p.district).slice(0, 120),
    address: String(p.address || '').slice(0, 300),
    longitude, latitude,
    route_m: p.route_m ?? null,
    area: p.area ?? null,
    coating: String(p.coating || '').slice(0, 120),
    popular: p.popular === true,
    popular_rank: p.popular_rank ?? null,
    popular_score: p.popular_score ?? null,
  });
}
const summary = { source, points: rows.length, popular: rows.filter((row) => row.popular).length, problems: problems.length, apply: args.includes('--apply') };
problems.slice(0, 20).forEach((line) => console.log('  ' + line));
if (!summary.apply) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const { Pool } = await import('pg');
const { photoServiceDatabaseConfig } = await import('../src/config.js');
const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const result = await client.query(`INSERT INTO pedestrian_path_points
      (id, point_no, path_id, ogh_id, ordinal, district, address, longitude, latitude, route_m, area, coating, popular, popular_rank, popular_score)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (point_no) DO UPDATE SET path_id = EXCLUDED.path_id, ogh_id = EXCLUDED.ogh_id,
        ordinal = EXCLUDED.ordinal, district = EXCLUDED.district, address = EXCLUDED.address,
        longitude = EXCLUDED.longitude, latitude = EXCLUDED.latitude, route_m = EXCLUDED.route_m,
        area = EXCLUDED.area, coating = EXCLUDED.coating, popular = EXCLUDED.popular,
        popular_rank = EXCLUDED.popular_rank, popular_score = EXCLUDED.popular_score,
        retired_at = NULL, updated_at = now()
      RETURNING (xmax = 0) AS inserted`,
    [crypto.randomUUID(), row.point_no, row.path_id, row.ogh_id, row.ordinal, row.district,
      row.address, row.longitude, row.latitude, row.route_m, row.area, row.coating,
      row.popular, row.popular_rank, row.popular_score]);
    if (result.rows[0]?.inserted) inserted++;
    else updated++;
  }
  const missing = await client.query(`UPDATE pedestrian_path_points p SET retired_at = now(), updated_at = now()
    WHERE p.retired_at IS NULL AND p.point_no <> ALL($1::text[])
      AND NOT EXISTS (SELECT 1 FROM pedestrian_path_photos f WHERE f.point_id = p.id)
    RETURNING p.point_no`, [rows.map((row) => row.point_no)]);
  await client.query('COMMIT');
  console.log(JSON.stringify({ ...summary, inserted, updated, retired: missing.rowCount }, null, 2));
} catch (error) {
  if (client) await client.query('ROLLBACK');
  throw error;
} finally {
  if (client) client.release();
  await pool.end();
}
