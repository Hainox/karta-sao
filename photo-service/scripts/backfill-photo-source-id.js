import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { assessDistanceRisk } from '../src/geo.js';

// Фиксации, загруженные до появления привязки к точке, знают только объект и
// место съёмки. Отметку восстанавливаем тем же правилом, что и живая служба:
// ближайшая зарегистрированная точка объекта к координатам съёмки. Внутри
// объекта выбор точки район не меняет, поэтому числа районов от разовой
// привязки не зависят — меняется только разбивка отметок внутри объекта.
const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--apply');

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
try {
  const result = await pool.query(`
    SELECT p.id, p.gps_latitude, p.gps_longitude, o.object_key, o.source_ids, o.reference_points
    FROM photos p
    JOIN objects o ON o.object_key = p.object_key
    WHERE p.source_id IS NULL
    ORDER BY p.uploaded_at, p.id
  `);

  const bindings = [];
  const skipped = { without_gps: 0, without_points: 0 };
  let furthestMeters = 0;
  for (const row of result.rows) {
    if (row.gps_latitude === null || row.gps_longitude === null) {
      skipped.without_gps += 1;
      continue;
    }
    const verdict = assessDistanceRisk(
      { latitude: Number(row.gps_latitude), longitude: Number(row.gps_longitude) },
      Array.isArray(row.reference_points) ? row.reference_points : [],
    );
    const sourceId = Array.isArray(row.source_ids) ? row.source_ids[verdict.referencePointIndex] : undefined;
    if (sourceId === undefined) {
      skipped.without_points += 1;
      continue;
    }
    furthestMeters = Math.max(furthestMeters, verdict.distanceMeters ?? 0);
    bindings.push({ id: row.id, sourceId });
  }

  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'apply',
    unbound_photos: result.rowCount,
    will_bind: bindings.length,
    skipped,
    furthest_meters: Number(furthestMeters.toFixed(1)),
  }, null, 2));

  if (dryRun || bindings.length === 0) process.exit(0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE photos SET source_id = binding.source_id
       FROM (SELECT * FROM unnest($1::text[], $2::text[]) AS t(id, source_id)) AS binding
       WHERE photos.id = binding.id`,
      [bindings.map((binding) => binding.id), bindings.map((binding) => binding.sourceId)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.log(`Bound ${bindings.length} photos to their nearest source point`);
} finally {
  await pool.end();
}
