// Выгрузка правок префектуры по точкам съёмки тротуаров: какие черновые точки
// перенесли, повернули, удалили, какие добавили и на каких уже есть фото.
// Нужна, чтобы новая черновая расстановка повторяла то, как ставят сотрудники.
// Печатает короткий текст: итоги по районам и одну строку на точку.
// База только читается.
//
//   node scripts/export-sidewalk-edits.js
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';

/**
 * Строка точки: номер;долгота;широта;направление;отметки.
 * Отметки: M — перенесена, R — повёрнута, D — удалена, A — добавлена префектурой,
 * P — есть фото (на проверке или принято).
 */
export function editLine(row) {
  const flags = [
    row.moved && 'M', row.rotated && 'R', row.retired_at && 'D',
    row.role === 'добавлена префектурой' && 'A', row.has_photo && 'P',
  ].filter(Boolean).join('');
  return [row.point_no, Number(row.longitude).toFixed(6), Number(row.latitude).toFixed(6), row.heading, flags].join(';');
}

export async function sidewalkEdits(db) {
  const { rows: totals } = await db.query(`SELECT district,
      count(*) FILTER (WHERE retired_at IS NULL)::int AS active,
      count(*) FILTER (WHERE updated_by IS NOT NULL)::int AS touched
    FROM sidewalk_photo_points GROUP BY district ORDER BY district`);
  // Точки, которые трогала префектура (updated_by), и нетронутые точки с фото —
  // их оставили как есть. Снятые импортом черновики (без updated_by) не нужны.
  const { rows: points } = await db.query(`SELECT p.point_no, p.district, p.longitude, p.latitude, p.heading, p.retired_at, p.role,
      coalesce(bool_or(a.action = 'sidewalk_point_update' AND a.metadata ? 'longitude'), false) AS moved,
      coalesce(bool_or(a.action = 'sidewalk_point_update' AND a.metadata ? 'heading'), false) AS rotated,
      EXISTS (SELECT 1 FROM sidewalk_photo_slot_photos f WHERE f.point_id = p.id AND f.status IN ('pending', 'accepted')) AS has_photo
    FROM sidewalk_photo_points p
    LEFT JOIN audit_log a ON a.object_key = 'sidewalk:' || p.point_no AND a.action LIKE 'sidewalk_point_%'
    GROUP BY p.id
    HAVING p.updated_by IS NOT NULL
      OR EXISTS (SELECT 1 FROM sidewalk_photo_slot_photos f WHERE f.point_id = p.id AND f.status IN ('pending', 'accepted'))
    ORDER BY p.district, p.point_no`);
  return { totals, points };
}

async function main() {
  const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
  try {
    const { totals, points } = await sidewalkEdits(pool);
    console.log('=== ТРОТУАРЫ: ПРАВКИ ПРЕФЕКТУРЫ ===');
    for (const t of totals) console.log(`# ${t.district}: точек ${t.active}, тронуто ${t.touched}`);
    console.log('# номер;долгота;широта;направление;M перенесена R повёрнута D удалена A добавлена P есть фото');
    for (const row of points) console.log(editLine(row));
    console.log(`=== КОНЕЦ: ${points.length} строк ===`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
