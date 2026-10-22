// Импорт эталонных точек съёмки NextGIS (слой «САО», 7 453 точки) в районный
// набор sao_district_photo_points. Перезапускаем безопасно: пары (район, номер)
// уже присутствующие в наборе пропускаются. По умолчанию — сухой прогон.
//
//   node scripts/import-district-photo-points.js --source=/tmp/nextgis.geojson [--apply]
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { createObjectPhotoPointRepository, validateObjectPhotoPoint } from '../src/tpu-points/object-photo-points.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sourceArg = args.find((a) => a.startsWith('--source='));
if (!sourceArg) {
  console.error('Usage: node scripts/import-district-photo-points.js --source=/path.geojson [--apply]');
  process.exit(2);
}

const SLUGS = {
  'Аэропорт': 'aeroport', 'Беговой': 'begovoy', 'Бескудниковский': 'beskudnikovskiy',
  'Войковский': 'voykovskiy', 'Восточное Дегунино': 'vostochnoe-degunino',
  'Головинский': 'golovinskiy', 'Дмитровский': 'dmitrovskiy',
  'Западное Дегунино': 'zapadnoe-degunino', 'Коптево': 'koptevo',
  'Левобережный': 'levoberezhnyy', 'Молжаниновский': 'molzhaninovskiy',
  'Савеловский': 'savelovskiy', 'Сокол': 'sokol', 'Тимирязевский': 'timiryazevskiy',
  'Ховрино': 'hovrino', 'Хорошевский': 'horoshevskiy',
};
const NAME_PREFIX = /^\d+\s*—\s*/;
const MERCATOR_R = 20037508.34;

/** Web Mercator (EPSG:3857, метры) -> WGS84 [долгота, широта]. */
function fromMercator(x, y) {
  const lon = (x / MERCATOR_R) * 180;
  const lat = (Math.atan(Math.exp((y / MERCATOR_R) * Math.PI)) * 360) / Math.PI - 90;
  return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
}

const boundary = JSON.parse(readFileSync(new URL('../src/tpu-points/sao_boundary_wgs84.geojson', import.meta.url), 'utf8'));
const data = JSON.parse(readFileSync(sourceArg.slice('--source='.length), 'utf8'));

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
try {
  const actor = await pool.query("SELECT id FROM users WHERE role = 'prefecture_admin' AND active = true ORDER BY id LIMIT 1");
  if (!actor.rows[0]) throw new Error('Нет активной учётной записи префектуры: импорт от чьего имени вести нечем.');
  const actorId = actor.rows[0].id;

  const repository = createObjectPhotoPointRepository(pool, {
    writeAudit(client, { actorId: by, eventType, metadata }) {
      return client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
        [by, eventType, metadata.objectKey || null, JSON.stringify(metadata)]);
    },
  });

  const existing = await pool.query("SELECT district, label FROM object_photo_points WHERE dataset_id = 'sao_district_photo_points' AND retired_at IS NULL");
  const seen = new Set(existing.rows.map((r) => `${r.district}\u0000${r.label}`));

  let inserted = 0; let skipped = 0; let rejected = 0;
  const problems = [];
  for (const feature of data.features || []) {
    const props = feature.properties || {};
    const district = String(props.district || props.layer || '').replace(NAME_PREFIX, '').trim();
    const label = String(props.field_1 ?? props.label ?? '').trim();
    if (!district || !label) { skipped += 1; continue; }
    if (seen.has(`${district}\u0000${label}`)) { skipped += 1; continue; }
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== 'Point' && geometry.type !== 'MultiPoint')) {
      rejected += 1; problems.push(`${label}: нет точечной геометрии`); continue;
    }
    let [longitude, latitude] = geometry.type === 'Point' ? geometry.coordinates : geometry.coordinates[0];
    // NextGIS отдаёт слой в EPSG:3857 (метры): переводим в WGS84.
    if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) [longitude, latitude] = fromMercator(longitude, latitude);
    const slug = SLUGS[district];
    if (!slug) { rejected += 1; problems.push(`${label}: неизвестный район «${district}»`); continue; }
    const input = {
      datasetId: 'sao_district_photo_points', objectKey: `district:${slug}`, objectType: 'district',
      district, longitude, latitude, label,
      note: String(props.note ?? props.source_note ?? '').slice(0, 2000),
      heading: props.heading == null ? null : Number(props.heading),
    };
    const validation = validateObjectPhotoPoint(input, boundary);
    if (!validation.valid) {
      rejected += 1; problems.push(`${label}: ${validation.errors.join('; ')}`); continue;
    }
    seen.add(`${district}\u0000${label}`);
    if (apply) await repository.createObjectPhotoPoint({ ...validation.value, actorId });
    inserted += 1;
    if (inserted % 500 === 0) console.log('processed', inserted + skipped + rejected, 'of', (data.features || []).length);
  }
  console.log(JSON.stringify({ apply, actorId, inserted, skipped, rejected, problems: problems.slice(0, 50) }, null, 2));
} finally {
  await pool.end();
}
