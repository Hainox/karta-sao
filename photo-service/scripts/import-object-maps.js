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

async function mapFile(relativePath) {
  const text = await readFile(new URL(relativePath, root), 'utf8');
  const match = text.match(/<script id="map-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`map-data script missing in ${relativePath}`);
  return JSON.parse(match[1]);
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

function baseObject(datasetId, objectType, reportKey, district, record, sourceIds, referencePoints) {
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
    sourceVersion: 'embedded-map-2026-09-15',
  };
}

function importStops(dataset, districts) {
  return dataset.records.map((record) => {
    const district = districtForPoint(record.lat, record.lon, districts);
    return baseObject(dataset.datasetId, 'stop', record.id, district, record, [record.id], [{ latitude: record.lat, longitude: record.lon }]);
  });
}

function importPp(dataset, districts) {
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
      group.records.map((record) => record.id), group.records.map((record) => ({ latitude: record.lat, longitude: record.lon })));
  });
}

function importEntrances(dataset, districts) {
  return dataset.records.map((record) => {
    const district = record.properties?.Район || districtForPoint(record.lat, record.lon, districts);
    const unom = String(record.properties?.УНОМ ?? record.id);
    const entrance = String(record.properties?.['№ подъезда'] ?? record.id);
    return baseObject(dataset.datasetId, 'entrance', `${unom}|${entrance}|${district || 'unassigned'}`, district, record, [record.id], [{ latitude: record.lat, longitude: record.lon }]);
  });
}

const [stops, pp, entrances, districts] = await Promise.all([
  mapFile('object-maps/stops.html'),
  mapFile('object-maps/pp.html'),
  mapFile('object-maps/entrances.html'),
  jsonFile('districts.geojson'),
]);
const objects = [...importStops(stops, districts.features), ...importPp(pp, districts.features), ...importEntrances(entrances, districts.features)];
const byType = Object.groupBy(objects, (object) => object.objectType);
console.log(JSON.stringify({ sourceRows: { stops: stops.records.length, pp: pp.records.length, entrances: entrances.records.length }, reportObjects: { stops: byType.stop.length, pp: byType.pp.length, entrances: byType.entrance.length }, unassigned: objects.filter((object) => object.district === null).length, mode: dryRun ? 'dry-run' : 'apply' }, null, 2));
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
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
console.log(`Imported ${objects.length} report objects`);
