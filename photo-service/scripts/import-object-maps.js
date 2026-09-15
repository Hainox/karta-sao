import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';

const sourceRootOption = process.argv.find((value) => value.startsWith('--source-root='));
const root = sourceRootOption ? pathToFileURL(resolve(sourceRootOption.slice('--source-root='.length)) + '/') : new URL('../../', import.meta.url);
const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--apply');

async function jsonFile(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), 'utf8'));
}

// The datasets live in object-maps/data and the manifest pins their SHA-256, so an
// import can prove which revision of the source it loaded instead of guessing.
async function loadDatasets() {
  const manifest = await jsonFile('object-maps/data/manifest.json');
  const datasets = {};
  const hashes = {};
  for (const entry of manifest.datasets) {
    const bytes = await readFile(new URL(`object-maps/data/${entry.file}`, root));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (entry.sha256 && entry.sha256 !== sha256) {
      throw new Error(`dataset ${entry.file} does not match the manifest hash: expected ${entry.sha256}, got ${sha256}`);
    }
    hashes[entry.file] = sha256;
    datasets[entry.key] = JSON.parse(bytes.toString('utf8'));
  }
  return { manifest, datasets, hashes };
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function districtForPoint(latitude, longitude, features) {
  const point = [longitude, latitude];
  for (const feature of features) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      if (pointInRing(point, polygon[0]) && polygon.slice(1).every((hole) => !pointInRing(point, hole))) {
        return feature.properties.district;
      }
    }
  }
  return null;
}

function baseObject(datasetId, objectType, reportKey, district, record, sourceIds, referencePoints, sourceVersion) {
  return {
    objectKey: `${datasetId}|${objectType}|${reportKey}`,
    datasetId,
    objectType,
    reportKey,
    sourceIds,
    district,
    label: record.label || reportKey,
    referencePoints,
    properties: record.properties || {},
    sourceVersion,
  };
}

function importStops(dataset, districts, sourceVersion) {
  return dataset.records.map((record) => {
    const district = districtForPoint(record.lat, record.lon, districts);
    return baseObject(dataset.datasetId, 'stop', record.id, district, record, [record.id], [{ latitude: record.lat, longitude: record.lon }], sourceVersion);
  });
}

function importPp(dataset, districts, sourceVersion) {
  const groups = new Map();
  for (const record of dataset.records) {
    const odhId = String(record.properties?.odh_id ?? record.id);
    const district = districtForPoint(record.lat, record.lon, districts);
    const groupKey = `${odhId}|${district || 'unassigned'}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { odhId, district, records: [] };
      groups.set(groupKey, group);
    }
    group.records.push(record);
  }
  return [...groups.values()].map((group) => {
    const first = group.records[0];
    return baseObject(dataset.datasetId, 'pp', `${group.odhId}|${group.district || 'unassigned'}`, group.district, first,
      group.records.map((record) => record.id), group.records.map((record) => ({ latitude: record.lat, longitude: record.lon })), sourceVersion);
  });
}

function importEntrances(dataset, districts, sourceVersion) {
  return dataset.records.map((record) => {
    const district = record.properties?.Район || districtForPoint(record.lat, record.lon, districts);
    const unom = String(record.properties?.УНОМ ?? record.id);
    const entrance = String(record.properties?.['№ подъезда'] ?? record.id);
    return baseObject(dataset.datasetId, 'entrance', `${unom}|${entrance}|${district || 'unassigned'}`, district, record, [record.id], [{ latitude: record.lat, longitude: record.lon }], sourceVersion);
  });
}

const { manifest, datasets, hashes } = await loadDatasets();
const districts = await jsonFile('districts.geojson');
const sourceVersion = manifest.sourceVersion;

const objects = [
  ...importStops(datasets.stops, districts.features, sourceVersion),
  ...importPp(datasets.pp, districts.features, sourceVersion),
  ...importEntrances(datasets.entrances, districts.features, sourceVersion),
];
const byType = Object.groupBy(objects, (object) => object.objectType);
const unassigned = objects.filter((object) => object.district === null);

// Borderline source rows must stay visible in the diagnostics instead of being
// silently assigned to a district, so every unassigned object is listed explicitly.
const datasetKeyByType = { stop: 'stops', pp: 'pp', entrance: 'entrances' };
const sourceRowByType = new Map(Object.entries(datasetKeyByType).map(([type, key]) => [
  type,
  new Map(datasets[key].records.map((record, index) => [record.id, record.sourceRow ?? index + 1])),
]));
const unassignedObjects = unassigned.map((object) => ({
  objectKey: object.objectKey,
  objectType: object.objectType,
  label: object.label,
  sourceIds: object.sourceIds,
  sourceRows: object.sourceIds
    .map((sourceId) => sourceRowByType.get(object.objectType)?.get(sourceId))
    .filter((row) => Number.isInteger(row)),
}));

const sourceRows = {
  stops: datasets.stops.records.length,
  pp: datasets.pp.records.length,
  entrances: datasets.entrances.records.length,
};
const reportObjects = {
  stops: (byType.stop || []).length,
  pp: (byType.pp || []).length,
  entrances: (byType.entrance || []).length,
};

console.log(JSON.stringify({
  sourceVersion,
  sourceDate: manifest.sourceDate,
  datasetHashes: hashes,
  sourceRows,
  reportObjects,
  unassigned: unassigned.length,
  unassignedObjects,
  mode: dryRun ? 'dry-run' : 'apply',
}, null, 2));

if (dryRun) process.exit(0);

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const object of objects) {
    await client.query(
      `INSERT INTO objects (object_key, dataset_id, object_type, report_key, source_ids, district, label, reference_points, properties, source_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (object_key) DO UPDATE SET dataset_id = EXCLUDED.dataset_id, object_type = EXCLUDED.object_type,
       report_key = EXCLUDED.report_key, source_ids = EXCLUDED.source_ids, district = EXCLUDED.district,
       label = EXCLUDED.label, reference_points = EXCLUDED.reference_points, properties = EXCLUDED.properties,
       source_version = EXCLUDED.source_version, updated_at = now()`,
      [object.objectKey, object.datasetId, object.objectType, object.reportKey, object.sourceIds, object.district, object.label, JSON.stringify(object.referencePoints), JSON.stringify(object.properties), object.sourceVersion],
    );
  }
  await client.query(
    `INSERT INTO import_runs (source_version, source_date, dataset_hashes, source_rows, report_objects, unassigned_count, unassigned_objects, mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'apply')`,
    [sourceVersion, manifest.sourceDate || null, JSON.stringify(hashes), JSON.stringify(sourceRows), JSON.stringify(reportObjects), unassigned.length, JSON.stringify(unassignedObjects)],
  );
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
console.log(`Imported ${objects.length} report objects from ${sourceVersion}`);
