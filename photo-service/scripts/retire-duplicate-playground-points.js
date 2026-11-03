// Снятие лишних точек фото площадок ДП/СП: одна площадка АСУ ОДС — одна точка.
// Группы точек одной площадки готовит projects/playground-photo-points/work/
// find_playground_duplicates.py (retire-lists/playground-duplicates.json). В каждой
// группе остаётся одна точка: с принятым фото, иначе с фото на проверке, иначе
// с возвращённым, иначе ближайшая к центру площадки (первая в группе). Остальные
// получают retired_at, если на них нет действующего фото; точки с фото на проверке
// или принятым не снимаются и выводятся отдельно — их решает префектура.
// Фото остаются в базе, каждое снятие пишется в audit_log. По умолчанию — сухой прогон.
//
//   node scripts/retire-duplicate-playground-points.js
//   node scripts/retire-duplicate-playground-points.js --actor=ЛОГИН_ПРЕФЕКТУРЫ --apply
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { normalizeLogin } from '../src/auth.js';

const LIST = new URL('./retire-lists/playground-duplicates.json', import.meta.url);
const RANK = { accepted: 0, pending: 1, rework: 2, empty: 3 };

/** Что снять: rows — { source_key, id, state, retired_at } по ключам групп. */
export function duplicatePlan(groups, rows) {
  const byKey = new Map(rows.map((row) => [row.source_key, row]));
  const retire = [];
  const keptWithPhoto = [];
  let groupsDone = 0;
  for (const group of groups) {
    const live = group.keys.map((key) => byKey.get(key)).filter((row) => row && !row.retired_at);
    if (live.length < 2) continue;
    groupsDone += 1;
    // Сортировка устойчивая: при равном состоянии остаётся ближайшая к центру.
    const [keep, ...rest] = [...live].sort((a, b) => RANK[a.state] - RANK[b.state]);
    for (const row of rest) {
      if (row.state === 'accepted' || row.state === 'pending') keptWithPhoto.push({ ...row, keep: keep.source_key, group });
      else retire.push({ ...row, keep: keep.source_key, group });
    }
  }
  return { retire, keptWithPhoto, groups: groupsDone };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const actorArg = process.argv.find((arg) => arg.startsWith('--actor='))?.slice(8);
  const { groups } = JSON.parse(readFileSync(LIST, 'utf8'));
  const keys = groups.flatMap((group) => group.keys);
  const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
  try {
    const { rows } = await pool.query(`SELECT p.id, p.source_key, p.district, p.kind, p.address, p.retired_at,
        COALESCE((SELECT f.status FROM playground_photo_slot_photos f WHERE f.point_id = p.id AND f.status IN ('pending', 'accepted') ORDER BY f.uploaded_at DESC LIMIT 1),
          (SELECT 'rework' FROM playground_photo_slot_photos f WHERE f.point_id = p.id AND f.status = 'rejected' LIMIT 1), 'empty') AS state
      FROM playground_photo_points p WHERE p.source_key = ANY($1)`, [keys]);
    const plan = duplicatePlan(groups, rows);
    const byDistrict = {};
    for (const row of plan.retire) byDistrict[row.district] = (byDistrict[row.district] || 0) + 1;
    console.log(`Площадок с лишними точками: ${plan.groups}; к снятию: ${plan.retire.length}; с фото, не снимаются: ${plan.keptWithPhoto.length}`);
    Object.entries(byDistrict).sort().forEach(([district, n]) => console.log(`  ${district}: ${n}`));
    plan.keptWithPhoto.forEach((row) => console.log(`  оставлена с фото (${row.state}): ${row.address || row.source_key}, рядом с ${row.keep}`));
    if (!apply) { console.log('Сухой прогон: база не изменена. Для снятия добавьте --actor=ЛОГИН_ПРЕФЕКТУРЫ --apply.'); return; }
    const login = normalizeLogin(actorArg);
    const actor = login && (await pool.query("SELECT id FROM users WHERE email = $1 AND role = 'prefecture_admin'", [login])).rows[0];
    if (!actor) { console.error('Укажите --actor= логин учётки префектуры: от её имени действие попадёт в журнал.'); process.exitCode = 2; return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let done = 0;
      for (const row of plan.retire) {
        const result = await client.query('UPDATE playground_photo_points SET retired_at = now(), updated_at = now() WHERE id = $1 AND retired_at IS NULL', [row.id]);
        if (!result.rowCount) continue;
        done += 1;
        await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1, $2, $3, $4::jsonb)',
          [actor.id, 'playground_point_retired', 'playground:' + row.source_key,
            JSON.stringify({ id: row.id, kept: row.keep, contour: row.group.contour_id, source: 'retire-duplicate-playground-points' })]);
      }
      await client.query('COMMIT');
      console.log(`Снято точек: ${done}.`);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
