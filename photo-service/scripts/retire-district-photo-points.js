// Снятие точек съёмки въездных групп по списку номеров («12.362» — Савеловский, точка 362).
// Делает то же, что кнопка «Удалить» в карточке точки на карте района: точка получает
// retired_at, фото остаются в базе, действие пишется в audit_log от имени учётки префектуры.
// По умолчанию — сухой прогон: показывает найденные точки, не найденные номера и точки с фото.
//
//   node scripts/retire-district-photo-points.js --list=scripts/retire-lists/2026-10-29-entrances.txt
//   node scripts/retire-district-photo-points.js --list=… --actor=ЛОГИН_ПРЕФЕКТУРЫ --apply
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { normalizeLogin } from '../src/auth.js';
import { DISTRICTS } from '../src/tpu-points/validation.js';
import { createObjectPhotoPointRepository } from '../src/tpu-points/object-photo-points.js';
import { PREFECTURE_ARCHIVE_CUTOFF } from '../src/tpu-points/district-point-photos.js';

const DATASET = 'sao_district_photo_points';
// Номер района в подписи точки — порядковый номер в списке районов САО (как на картах районов).
const DISTRICT_BY_NO = new Map([...DISTRICTS].map((name, index) => [String(index + 1), name]));

/**
 * Номера точек из произвольного текста (переписка, документ): «Точка съёмки 12.362», «9.215».
 * Номер района — 1–2 цифры, номер точки — до 4 цифр, поэтому склеенное «15.101515.1014»
 * читается как две точки. Повторы убираются, порядок сохраняется.
 */
export function parsePointLabels(text) {
  const labels = [];
  const problems = [];
  for (const [, no, n] of String(text).matchAll(/(?<!\.)(\d{1,2})\.(\d{1,4})/g)) {
    const district = DISTRICT_BY_NO.get(no);
    if (!district) { problems.push(`${no}.${n}: нет района с номером ${no}`); continue; }
    const label = `${no}.${Number(n)}`;
    if (!labels.some((item) => item.label === label)) labels.push({ label, district });
  }
  return { labels, problems };
}

/**
 * Что снимать: активные точки рабочего слоя по подписи и району — те, что префектура видит
 * на карте района. Архивные точки (до 23.10) и импортные наборы (NextGIS/GPKG) с теми же
 * номерами на карте не показываются, поэтому не снимаются, а выводятся отдельно.
 */
export async function retirePlan(db, labels) {
  const { rows } = await db.query(`SELECT p.id, p.label, p.district, p.retired_at,
      (p.created_at < ${PREFECTURE_ARCHIVE_CUTOFF} OR COALESCE(p.note, '') LIKE 'Источник:%') AS hidden,
      (SELECT count(*)::int FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status IN ('pending', 'accepted')) AS live_photos
    FROM object_photo_points p
    WHERE p.dataset_id = $1 AND p.label = ANY($2)`, [DATASET, labels.map((item) => item.label)]);
  const retire = [];
  const missing = [];
  const already = [];
  const kept = [];
  const doubled = [];
  for (const { label, district } of labels) {
    const own = rows.filter((row) => row.label === label && row.district === district);
    const active = own.filter((row) => row.retired_at == null && !row.hidden);
    kept.push(...own.filter((row) => row.retired_at == null && row.hidden));
    if (active.length > 1) doubled.push(label);
    if (active.length) retire.push(...active);
    else if (own.some((row) => !row.hidden)) already.push(label);
    else missing.push(label);
  }
  return { retire, missing, already, kept, doubled, withPhotos: retire.filter((row) => row.live_photos > 0) };
}

async function main() {
  const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const apply = process.argv.includes('--apply');
  const list = option('list');
  if (!list) {
    console.error('Usage: node scripts/retire-district-photo-points.js --list=FILE [--actor=LOGIN --apply]');
    process.exit(2);
  }
  const { labels, problems } = parsePointLabels(readFileSync(list, 'utf8'));
  const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
  try {
    const plan = await retirePlan(pool, labels);
    const byDistrict = {};
    for (const row of plan.retire) byDistrict[row.district] = (byDistrict[row.district] || 0) + 1;
    console.log(`Номеров в списке: ${labels.length}; к снятию: ${plan.retire.length}; уже сняты: ${plan.already.length}; не найдены: ${plan.missing.length}`);
    Object.entries(byDistrict).forEach(([district, n]) => console.log(`  ${district}: ${n}`));
    if (plan.withPhotos.length) console.log(`С фото на проверке или принятыми (фото останутся в базе): ${plan.withPhotos.map((row) => row.label).join(', ')}`);
    if (plan.kept.length) console.log(`Архивные или импортные точки с теми же номерами (на карте не видны, не снимаются): ${plan.kept.length}`);
    if (plan.doubled.length) console.log(`Несколько точек рабочего слоя под одним номером (снимаются все): ${plan.doubled.join(', ')}`);
    if (plan.already.length) console.log(`Уже сняты: ${plan.already.join(', ')}`);
    if (plan.missing.length) console.log(`Не найдены: ${plan.missing.join(', ')}`);
    problems.forEach((line) => console.log('  ' + line));
    if (!apply) { console.log('Сухой прогон: база не изменена. Для снятия добавьте --actor=ЛОГИН_ПРЕФЕКТУРЫ --apply.'); return; }

    const login = normalizeLogin(option('actor'));
    const actor = login && (await pool.query("SELECT id FROM users WHERE email = $1 AND role = 'prefecture_admin'", [login])).rows[0];
    if (!actor) { console.error('Укажите --actor= логин учётки префектуры: от её имени действие попадёт в журнал.'); process.exitCode = 2; return; }
    const repository = createObjectPhotoPointRepository(pool, {
      writeAudit(client, { actorId, eventType, metadata }) {
        return client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)', [actorId, eventType, null, JSON.stringify({ ...metadata, source: 'retire-district-photo-points' })]);
      },
    });
    let done = 0;
    for (const row of plan.retire) {
      if (await repository.retireObjectPhotoPoint({ id: row.id, actorId: actor.id })) done += 1;
    }
    console.log(`Снято точек: ${done}.`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
