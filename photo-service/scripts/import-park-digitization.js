import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDatabasePool } from '../src/db-pool.js';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { DISTRICTS, isPointWithinBoundary } from '../src/tpu-points/validation.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const statuses = new Set(['unverified', 'matched', 'absent_in_source', 'conflict']);

export async function importParks(client, catalog, { objectsOnly = false, updateRegistry = false } = {}) {
  const { parks, points } = catalog;
  if (catalog.version !== 1 || !parks?.length || !Array.isArray(points)) throw new Error('Некорректный каталог парков.');
  const parkIds = new Map();
  for (const park of parks) {
    if (!UUID.test(park.id) || parkIds.has(park.id) || !DISTRICTS.has(park.district) || !park.name?.trim() ||
        !Array.isArray(park.asu_ids) || !park.asu_ids.every(id => typeof id === 'string' && /^\d+$/.test(id)) ||
        !Array.isArray(park.source_objects) || !park.source_objects.length || !statuses.has(park.registry_status) ||
        typeof park.needs_review !== 'boolean' || (park.geometry && !['Polygon', 'MultiPolygon'].includes(park.geometry.type))) {
      throw new Error('Некорректная запись парков в каталоге.');
    }
    parkIds.set(park.id, park);
  }
  const pointIds = new Set();
  const frames = new Set();
  const boundary = JSON.parse(await readFile(new URL('../src/tpu-points/sao_boundary_wgs84.geojson', import.meta.url), 'utf8'));
  for (const point of points) {
    const park = parkIds.get(point.parkId);
    if (!park?.geometry || !UUID.test(point.id) || pointIds.has(point.id) ||
        !UUID.test(point.slot?.id) || frames.has(point.slot.id) || !Array.isArray(point.coordinates) ||
        point.coordinates.length !== 2 || !point.coordinates.every(Number.isFinite) ||
        !isPointWithinBoundary(point.coordinates, boundary) ||
        !isPointWithinBoundary(point.coordinates, { features: [{ geometry: park.geometry }] }) ||
        !Number.isFinite(point.slot.azimuth) || point.slot.azimuth < 0 || point.slot.azimuth >= 360) {
      throw new Error('Некорректная исходная точка ' + point.id + '.');
    }
    pointIds.add(point.id);
    frames.add(point.slot.id);
  }
  for (const park of parks) {
    const args = [park.id, park.district, park.name, park.asu_ids, JSON.stringify(park.source_objects),
      park.geometry ? JSON.stringify(park.geometry) : null, park.geometry_source, park.registry_status, park.needs_review];
    const registry = updateRegistry
      ? `DO UPDATE SET name = EXCLUDED.name, asu_ids = EXCLUDED.asu_ids, source_objects = EXCLUDED.source_objects,
          geometry = EXCLUDED.geometry, geometry_source = EXCLUDED.geometry_source, registry_status = EXCLUDED.registry_status,
          needs_review = EXCLUDED.needs_review WHERE park_digitization_objects.district = EXCLUDED.district`
      : 'DO NOTHING';
    const result = await client.query(`INSERT INTO park_digitization_objects
      (id, district, name, asu_ids, source_objects, geometry, geometry_source, registry_status, needs_review)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9) ON CONFLICT (id) ${registry}`, args);
    if (updateRegistry && !result.rowCount) throw new Error('Изменение района требует отдельной сверки. ' + park.id);
  }
  let inserted = 0;
  if (!objectsOnly) {
    for (const point of points) {
      const result = await client.query(`INSERT INTO park_digitization_points (id, park_id, frame_id, longitude, latitude, azimuth)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [point.id, point.parkId, point.slot.id, ...point.coordinates, point.slot.azimuth]);
      inserted += result.rowCount;
    }
  }
  return { parks: parks.length, points: points.length, inserted };
}

async function main() {
  const args = process.argv.slice(2);
  const source = args.find(arg => !arg.startsWith('--'));
  const apply = args.includes('--apply');
  const updateRegistry = args.includes('--update-registry');
  if (!source) throw new Error('Укажите путь к каталогу. Для записи добавьте --apply.');
  const pool = createDatabasePool(photoServiceDatabaseConfig(process.env));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await importParks(client, JSON.parse(await readFile(source, 'utf8')), { updateRegistry, objectsOnly: updateRegistry });
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ ...result, applied: apply, updateRegistry }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
