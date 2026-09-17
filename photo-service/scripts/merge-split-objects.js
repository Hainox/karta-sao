// Слияние разорванных объектов ПП.
//
// До правки импорта один объект ОДХ (`odh_id`) мог лечь в базу двумя строками —
// «odh_id + район» на каждую сторону границы. Отсюда лишний пешеходный переход
// у района: у Коптево выходило 129 вместо 128. Скрипт приводит базу к правилу
// «один odh_id — один объект», а район берёт из исходных данных по большинству
// точек (та же функция, что в импорте).
//
//   node scripts/merge-split-objects.js            # только план, ничего не меняет
//   node scripts/merge-split-objects.js --apply    # слить и перенести фото
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { districtResolver } from '../src/districts.js';
import { groupPpRecords, ppReportKey } from '../src/pp-objects.js';

const sourceRootOption = process.argv.find((value) => value.startsWith('--source-root='));
const root = sourceRootOption
  ? pathToFileURL(resolve(sourceRootOption.slice('--source-root='.length)) + '/')
  : new URL('../../', import.meta.url);
const apply = new Set(process.argv.slice(2)).has('--apply');

const dataset = JSON.parse(await readFile(new URL('object-maps/data/pp.json', root), 'utf8'));
const districts = JSON.parse(await readFile(new URL('districts.geojson', root), 'utf8'));

// Ожидаемое состояние берётся из источника, а не из базы: так результат совпадёт
// с тем, что даст повторный импорт.
const expected = new Map();
for (const group of groupPpRecords(dataset.records, districtResolver(districts.features))) {
  expected.set(group.odhId, {
    district: group.district,
    sourceIds: group.records.map((record) => record.id),
    referencePoints: group.records.map((record) => ({ latitude: record.lat, longitude: record.lon })),
  });
}

const pool = new Pool(photoServiceDatabaseConfig(process.env));

try {
  const { rows } = await pool.query(
    "SELECT object_key, report_key, district, source_ids, reference_points FROM objects WHERE object_type = 'pp' ORDER BY object_key",
  );

  const groups = new Map();
  for (const row of rows) {
    const odhId = String(row.report_key).split('|')[0];
    if (!groups.has(odhId)) groups.set(odhId, []);
    groups.get(odhId).push(row);
  }

  const plans = [];
  for (const [odhId, list] of groups) {
    if (list.length < 2) continue;
    const datasetId = list[0].object_key.split('|')[0];
    const target = expected.get(odhId);
    const targetKey = `${datasetId}|pp|${ppReportKey(odhId, target?.district ?? list[0].district)}`;
    const primary = list.find((row) => row.object_key === targetKey)
      || list.slice().sort((left, right) => (right.source_ids?.length || 0) - (left.source_ids?.length || 0))[0];
    plans.push({
      odhId,
      datasetId,
      primary,
      orphans: list.filter((row) => row.object_key !== primary.object_key),
      targetKey,
      expectedDistrict: target?.district ?? primary.district,
      sourceIds: target?.sourceIds ?? null,
      referencePoints: target?.referencePoints ?? null,
    });
  }

  console.log(`объектов ПП в базе: ${rows.length}`);
  console.log(`разорванных объектов (один odh_id в нескольких строках): ${plans.length}`);
  if (!plans.length) console.log('сливать нечего.');

  let movedPhotos = 0;
  for (const plan of plans) {
    const groupKeys = [plan.primary.object_key, ...plan.orphans.map((row) => row.object_key)];
    const { rows: counted } = await pool.query('SELECT count(*)::int AS count FROM photos WHERE object_key = ANY($1)', [groupKeys]);
    const photos = counted[0]?.count || 0;
    movedPhotos += photos;

    const rename = plan.primary.object_key !== plan.targetKey;
    console.log(`\nodh_id ${plan.odhId}: ${groupKeys.length} строк → одна`);
    console.log(`  цель: ${plan.targetKey} (район «${plan.expectedDistrict}»)${rename ? ` — переименование из ${plan.primary.object_key}` : ''}`);
    for (const row of plan.orphans) console.log(`  слияние: ${row.object_key} (точек ${row.source_ids?.length || 0}, район «${row.district || 'без района'}»)`);
    console.log(`  фото в группе: ${photos}`);

    if (!apply) continue;
    const groupRows = [plan.primary, ...plan.orphans];
    const sourceIds = plan.sourceIds || dedupeStrings(groupRows.flatMap((row) => row.source_ids || []));
    const referencePoints = plan.referencePoints || dedupePoints(groupRows.flatMap((row) => row.reference_points || []));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO audit_log (action, object_key, metadata) VALUES ('object_merged', $1, $2)", [
        plan.targetKey,
        JSON.stringify({ merged: plan.orphans.map((row) => row.object_key), district: plan.expectedDistrict, photos, sourcePoints: sourceIds.length }),
      ]);
      if (rename) {
        // Целевой строки ещё нет: сначала создаём её, потом переносим фото —
        // внешний ключ photos.object_key не даёт ссылаться на несуществующий объект.
        await client.query(
          `INSERT INTO objects (object_key, dataset_id, object_type, report_key, source_ids, district, label, reference_points, properties, source_version)
           SELECT $1, dataset_id, object_type, $2, $3::text[], $4, label, $5::jsonb, properties, source_version
             FROM objects WHERE object_key = $6`,
          [plan.targetKey, ppReportKey(plan.odhId, plan.expectedDistrict), sourceIds, plan.expectedDistrict, JSON.stringify(referencePoints), plan.primary.object_key],
        );
        await client.query('UPDATE photos SET object_key = $1 WHERE object_key = ANY($2)', [plan.targetKey, groupKeys]);
        await client.query('DELETE FROM objects WHERE object_key = ANY($1)', [groupKeys]);
      } else {
        await client.query('UPDATE photos SET object_key = $1 WHERE object_key = ANY($2)', [plan.targetKey, plan.orphans.map((row) => row.object_key)]);
        await client.query('DELETE FROM objects WHERE object_key = ANY($1)', [plan.orphans.map((row) => row.object_key)]);
        await client.query('UPDATE objects SET source_ids = $2, reference_points = $3::jsonb, district = $4, report_key = $5, updated_at = now() WHERE object_key = $1', [
          plan.targetKey, sourceIds, JSON.stringify(referencePoints), plan.expectedDistrict, ppReportKey(plan.odhId, plan.expectedDistrict),
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  console.log(`\n${apply ? 'выполнено' : 'план без изменений'}: разорванных объектов ${plans.length}, фото к переносу ${movedPhotos}.`);
  if (!apply && plans.length) console.log('чтобы применить, повторите с --apply');
} finally {
  await pool.end();
}

function dedupeStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function dedupePoints(points) {
  const seen = new Set();
  const result = [];
  for (const point of points) {
    const latitude = Number(point?.latitude);
    const longitude = Number(point?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const key = `${latitude},${longitude}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ latitude, longitude });
  }
  return result;
}
