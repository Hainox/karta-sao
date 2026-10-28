// Импорт точек съёмки тротуаров из районных слоёв атласа
// (districts/layers/<район>/sidewalk_shoot.geojson) в sidewalk_photo_points.
// Перезапуск безопасен: точка с уже известным номером пропускается, поэтому
// правки префектуры (перенос, направление, удаление) не перетираются.
// --replace: новая расстановка заменяет черновики без правок и фото (см. importPlan).
// По умолчанию — сухой прогон.
//
//   node scripts/import-sidewalk-photo-points.js --source=/sources/districts/layers [--replace] [--apply]
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
  const replace = args.includes('--replace');
  const sourceArg = args.find((a) => a.startsWith('--source='));
  if (!sourceArg) {
    console.error('Usage: node scripts/import-sidewalk-photo-points.js --source=/path/to/districts/layers [--replace] [--apply]');
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
    const plan = await importPlan(pool, rows, { replace });
    console.log(`В слоях точек: ${rows.length}; уже в базе: ${rows.length - plan.insert.length}; новых: ${plan.insert.length}; с ошибками: ${problems.length}`);
    if (replace) {
      console.log(`Замена черновиков: обновить ${plan.update.length}; снять ${plan.retire.length}; оставить с правками или фото ${plan.kept.length}`);
      plan.kept.slice(0, 20).forEach((no) => console.log('  оставлена: ' + no));
    }
    problems.slice(0, 20).forEach((line) => console.log('  ' + line));
    if (!apply) { console.log('Сухой прогон: база не изменена. Для записи добавьте --apply.'); return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of plan.insert) {
        await client.query(`INSERT INTO sidewalk_photo_points
          (id, point_no, district, address, unom, role, side, also_covers, longitude, latitude, heading, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (point_no) DO NOTHING`,
        [crypto.randomUUID(), r.point_no, r.district, r.address, r.unom, r.role, r.side, r.also_covers, r.longitude, r.latitude, r.heading, r.status]);
      }
      for (const r of plan.update) {
        await client.query(`UPDATE sidewalk_photo_points SET district = $2, address = $3, unom = $4, role = $5, side = $6,
          also_covers = $7, longitude = $8, latitude = $9, heading = $10, status = $11, retired_at = NULL, updated_at = now()
          WHERE point_no = $1 AND updated_by IS NULL`,
        [r.point_no, r.district, r.address, r.unom, r.role, r.side, r.also_covers, r.longitude, r.latitude, r.heading, r.status]);
      }
      if (plan.retire.length) {
        await client.query(`UPDATE sidewalk_photo_points SET retired_at = now(), updated_at = now()
          WHERE point_no = ANY($1) AND updated_by IS NULL AND retired_at IS NULL`, [plan.retire]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    console.log(`Записано точек: ${plan.insert.length}${replace ? `; обновлено: ${plan.update.length}; снято: ${plan.retire.length}` : ''}.`);
  } finally {
    await pool.end();
  }
}

/**
 * Что делать с базой. Без --replace — только новые номера. С --replace черновики
 * без правок префектуры (updated_by пуст) и без фото обновляются на новое место,
 * лишние такие черновики снимаются, а точки с правками или фото не трогаются.
 */
export async function importPlan(db, rows, { replace = false } = {}) {
  const hasPhotos = (await db.query("SELECT to_regclass('sidewalk_photo_slot_photos') IS NOT NULL AS ok")).rows[0].ok;
  const { rows: existing } = await db.query(`SELECT p.point_no, p.retired_at, p.updated_by,
      ${hasPhotos ? 'EXISTS (SELECT 1 FROM sidewalk_photo_slot_photos f WHERE f.point_id = p.id)' : 'false'} AS has_photo
    FROM sidewalk_photo_points p`);
  const byNo = new Map(existing.map((r) => [r.point_no, r]));
  const touched = (r) => r.updated_by != null || r.has_photo;
  const insert = rows.filter((r) => !byNo.has(r.point_no));
  if (!replace) return { insert, update: [], retire: [], kept: [] };
  const inLayer = new Set(rows.map((r) => r.point_no));
  const update = [];
  const kept = [];
  for (const r of rows) {
    const old = byNo.get(r.point_no);
    if (!old) continue;
    if (touched(old)) kept.push(r.point_no); else update.push(r);
  }
  const retire = existing.filter((r) => !inLayer.has(r.point_no) && r.retired_at == null && !touched(r)).map((r) => r.point_no);
  for (const r of existing) if (!inLayer.has(r.point_no) && r.retired_at == null && touched(r)) kept.push(r.point_no);
  return { insert, update, retire, kept };
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
