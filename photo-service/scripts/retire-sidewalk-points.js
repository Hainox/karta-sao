// Снятие точек съёмки тротуаров по списку номеров (Т15.208 …), например лишних
// точек префектуры по правилу подъездов (scripts/retire-lists/sidewalk-rule-<район>.txt).
// Делает то же, что кнопка «Удалить» в карточке точки: retired_at, запись в audit_log
// от имени учётки префектуры. Не снимаются точки с фото (на проверке или принятым)
// и точки, которые меняли после выгрузки правок (--since): их список строился без этих правок.
// По умолчанию — сухой прогон.
//
//   node scripts/retire-sidewalk-points.js --list=scripts/retire-lists/sidewalk-rule-hovrino.txt --since=2026-11-02T00:00:00+03:00
//   node scripts/retire-sidewalk-points.js --list=… --since=… --actor=ЛОГИН_ПРЕФЕКТУРЫ --apply
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { normalizeLogin } from '../src/auth.js';

/** Номера точек из текста списка: строки вида «Т15.208», комментарии с # пропускаются. */
export function parseSidewalkList(text) {
  const numbers = [];
  for (const line of String(text).split('\n')) {
    const match = line.replace(/#.*/, '').trim().match(/^Т\d{1,2}\.\d{3,4}$/);
    if (match && !numbers.includes(match[0])) numbers.push(match[0]);
  }
  return numbers;
}

/**
 * Что снимать. rows — { point_no, retired_at, updated_at, created_at, live_photos } по номерам списка.
 * Точка с фото или изменённая после since остаётся и попадает в отдельный список.
 */
export function sidewalkRetirePlan(numbers, rows, since) {
  const byNo = new Map(rows.map((row) => [row.point_no, row]));
  const plan = { retire: [], withPhoto: [], changedLater: [], already: [], missing: [] };
  for (const no of numbers) {
    const row = byNo.get(no);
    if (!row) plan.missing.push(no);
    else if (row.retired_at) plan.already.push(no);
    else if (row.live_photos > 0) plan.withPhoto.push(no);
    else if (new Date(row.updated_at) > since || new Date(row.created_at) > since) plan.changedLater.push(no);
    else plan.retire.push(row);
  }
  return plan;
}

async function main() {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const apply = process.argv.includes('--apply');
  const since = new Date(arg('since'));
  if (!arg('list') || Number.isNaN(since.getTime())) {
    console.error('Usage: node scripts/retire-sidewalk-points.js --list=FILE --since=ISO-время-выгрузки [--actor=ЛОГИН --apply]');
    process.exit(2);
  }
  const numbers = parseSidewalkList(readFileSync(arg('list'), 'utf8'));
  const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
  try {
    const { rows } = await pool.query(`SELECT p.id, p.point_no, p.district, p.retired_at, p.updated_at, p.created_at,
        (SELECT count(*)::int FROM sidewalk_photo_slot_photos f WHERE f.point_id = p.id AND f.status IN ('pending', 'accepted')) AS live_photos
      FROM sidewalk_photo_points p WHERE p.point_no = ANY($1)`, [numbers]);
    const plan = sidewalkRetirePlan(numbers, rows, since);
    console.log(`В списке: ${numbers.length}; к снятию: ${plan.retire.length}; с фото, не снимаются: ${plan.withPhoto.length}; `
      + `менялись после выгрузки, не снимаются: ${plan.changedLater.length}; уже сняты: ${plan.already.length}; нет в базе: ${plan.missing.length}`);
    if (plan.withPhoto.length) console.log('  с фото: ' + plan.withPhoto.join(', '));
    if (plan.changedLater.length) console.log('  менялись после выгрузки: ' + plan.changedLater.join(', '));
    if (plan.missing.length) console.log('  нет в базе: ' + plan.missing.join(', '));
    if (!apply) { console.log('Сухой прогон: база не изменена. Для снятия добавьте --actor=ЛОГИН_ПРЕФЕКТУРЫ --apply.'); return; }
    const login = normalizeLogin(arg('actor'));
    const actor = login && (await pool.query("SELECT id FROM users WHERE email = $1 AND role = 'prefecture_admin'", [login])).rows[0];
    if (!actor) { console.error('Укажите --actor= логин учётки префектуры: от её имени действие попадёт в журнал.'); process.exitCode = 2; return; }
    const client = await pool.connect();
    let done = 0;
    try {
      await client.query('BEGIN');
      for (const row of plan.retire) {
        const { rowCount } = await client.query(`UPDATE sidewalk_photo_points SET retired_at = now(), updated_at = now(), updated_by = $2
          WHERE id = $1 AND retired_at IS NULL`, [row.id, actor.id]);
        if (!rowCount) continue;
        done += 1;
        await client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1, $2, $3, $4::jsonb)',
          [actor.id, 'sidewalk_point_retire', 'sidewalk:' + row.point_no, JSON.stringify({ id: row.id, source: 'retire-sidewalk-points' })]);
      }
      await client.query('COMMIT');
      console.log(`Снято точек: ${done}.`);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
