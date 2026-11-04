// Частые причины возврата фото на доработку — для выпадающего списка во всех
// кабинетах приёмки (фотофиксация, районные точки, площадки, тротуары, ТПУ).
// Причины берутся из уже отправленных возвратов всех приёмок; пока своих
// возвратов мало, список дополняют типовые причины.

/** Типовые причины: показываются после реальных, если таких ещё не писали. */
export const DEFAULT_REVIEW_REASONS = [
  'Фото размытое или нечёткое — переснимите',
  'Объект не попал в кадр целиком',
  'Снято не с той точки или не в ту сторону — снимите по стрелке точки',
  'Не тот объект или адрес',
  'Слишком темно или засвечено',
  'Объект закрыт машинами, людьми или деревьями',
  'Снято слишком близко — нужен общий план',
  'Не видно адресной таблички или номера дома',
  'Фото сделано не на месте — геометка далеко от объекта',
  'Старое или повторное фото — нужен новый снимок',
  'Кадр завален или перевёрнут',
  'На фото не устранены нарушения (мусор, снег, повреждения)',
];

// Таблица → столбец причины и условие «возвращено на доработку».
const SOURCES = [
  ['photos', `SELECT review_reason AS reason FROM photos WHERE review_status = 'rejected'`],
  ['object_slot_photos', `SELECT review_comment AS reason FROM object_slot_photos WHERE status = 'rejected'`],
  ['object_photo_point_photos', `SELECT review_comment AS reason FROM object_photo_point_photos WHERE status = 'rejected'`],
  ['playground_photo_slot_photos', `SELECT review_comment AS reason FROM playground_photo_slot_photos WHERE status = 'rejected'`],
  ['sidewalk_photo_slot_photos', `SELECT review_comment AS reason FROM sidewalk_photo_slot_photos WHERE status = 'rejected'`],
];

const MIN_LENGTH = 4;
const MAX_LENGTH = 160; // длинный разбор конкретного кадра не годится как готовая причина

/** Ключ для склейки одинаковых причин: регистр, ё, пробелы и точка в конце не важны. */
export function reasonKey(text) {
  return String(text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[\s.!,;:]+$/u, '').trim();
}

/**
 * Список для выпадающего меню. rows — { reason, n } (одна строка на написание).
 * Одинаковые по ключу причины складываются, показывается самое частое написание.
 * Сначала реальные причины от двух повторов по убыванию частоты, затем типовые.
 */
export function rankReviewReasons(rows, { limit = 15, defaults = DEFAULT_REVIEW_REASONS } = {}) {
  const groups = new Map();
  for (const { reason, n } of rows) {
    const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
    const key = reasonKey(text);
    if (key.length < MIN_LENGTH || text.length > MAX_LENGTH) continue;
    const group = groups.get(key) || { count: 0, variants: new Map() };
    group.count += Number(n) || 0;
    group.variants.set(text, (group.variants.get(text) || 0) + (Number(n) || 0));
    groups.set(key, group);
  }
  const used = [...groups.entries()]
    .filter(([, g]) => g.count >= 2)
    .map(([key, g]) => ({ key, text: [...g.variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], count: g.count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'ru'));
  const seen = new Set(used.map((r) => r.key));
  const fill = defaults.filter((text) => !seen.has(reasonKey(text))).map((text) => ({ text, count: 0 }));
  return [...used, ...fill].slice(0, limit).map(({ text, count }) => ({ text, count }));
}

/** Причины из всех приёмок, что есть в этой базе (таблицы появляются миграциями). */
export async function loadReviewReasons(db, options = {}) {
  const names = SOURCES.map(([table]) => table);
  const { rows: present } = await db.query(
    'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL', [names]);
  const have = new Set(present.map((r) => r.name));
  const parts = SOURCES.filter(([table]) => have.has(table)).map(([, sql]) => sql);
  if (!parts.length) return rankReviewReasons([], options);
  const { rows } = await db.query(`SELECT reason, count(*)::int AS n FROM (${parts.join(' UNION ALL ')}) r
    WHERE reason IS NOT NULL AND btrim(reason) <> '' GROUP BY reason`);
  return rankReviewReasons(rows, options);
}
