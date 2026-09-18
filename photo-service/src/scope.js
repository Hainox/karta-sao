// Учётка владельца «АвД САО» ведёт свои объекты по всему округу: они стоят в
// разных районах, поэтому ограничение по району к ней не подходит. В её зону
// входят объекты с балансодержателем «АвД САО», с балансодержателем «ДЭУ N»
// и объекты, оставшиеся без района.
export const AUTODOR_HOLDER = 'АвД САО';

export function isAutodorAccount(district) {
  return String(district ?? '').trim().toLowerCase() === AUTODOR_HOLDER.toLowerCase();
}

export function isAutodorHolder(holder) {
  const value = String(holder ?? '').trim();
  return value.toLowerCase() === AUTODOR_HOLDER.toLowerCase() || /^ДЭУ/i.test(value);
}

// Балансодержатель лежит в свойствах под разными именами по наборам.
const HOLDER_SQL = "coalesce(nullif(o.properties->>'Балансодержатель', ''), nullif(o.properties->>'Баланс', ''))";

// Объект принадлежит владельцу «АвД САО» или «ДЭУ N», а не району, где стоит.
// Проверка на NULL обязательна: у подъездов владельца нет вовсе, а `NOT (NULL = …)`
// в SQL даёт NULL, и тогда условие «не АвД» выбросило бы все подъезды.
const AUTODOR_HOLDER_SQL = `(${HOLDER_SQL} IS NOT NULL AND (${HOLDER_SQL} = 'АвД САО' OR ${HOLDER_SQL} ILIKE 'ДЭУ%'))`;

/** Условие выборки объектов для учётки АвД. */
export const AUTODOR_OBJECT_SQL = `(o.district IS NULL OR ${AUTODOR_HOLDER_SQL})`;

/** Район объекта в виде, пригодном для сравнения: без регистра, пробелов и «ё». */
const DISTRICT_KEY_SQL = "replace(lower(btrim(coalesce(o.district, ''))), 'ё', 'е')";

/**
 * SQL-условие «район объекта равен району учётки». Пишется на сервере, чтобы
 * районная учётка не получала пустую сводку из-за регистра или «ё» в названии.
 */
export function districtMatchSql(parameter = '$1') {
  return `${DISTRICT_KEY_SQL} = replace(lower(btrim(${parameter})), 'ё', 'е')`;
}

/**
 * Условие «объект ведёт этот район»: совпадает район и владелец — сам район.
 * Объекты «АвД САО» и «ДЭУ N» стоят на территории района, но ведёт их владелец,
 * поэтому в районную сводку они не попадают — то же правило, что в
 * `reportingDistrict` и в штабной таблице.
 */
export function districtScopeSql(parameter = '$1') {
  return `(${districtMatchSql(parameter)} AND NOT ${AUTODOR_HOLDER_SQL})`;
}

/** Выражение балансодержателя для выборок, которые проверяют доступ построчно. */
export const HOLDER_SELECT_SQL = `${HOLDER_SQL} AS balance_holder`;

/**
 * Сравнение района без учёта регистра и внешних пробелов.
 *
 * Район учётки вводит администратор при заведении (`create-user.js` только
 * обрезает пробелы), а объекты получают район из `districts.geojson`. Любое
 * расхождение в написании («молжаниновский» против «Молжаниновский») раньше
 * давало успешный вход и пустую сводку — это и выглядело как «вход выполнен, а
 * ниже неверно».
 */
export function normalizeDistrict(value) {
  return String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е');
}

export function sameDistrict(left, right) {
  const first = normalizeDistrict(left);
  const second = normalizeDistrict(right);
  return Boolean(first) && first === second;
}

/** Может ли учётка работать с этим объектом. */
export function objectAllowedFor(user, object) {
  if (user?.role !== 'district_editor') return true;
  if (isAutodorAccount(user.district)) return !object?.district || isAutodorHolder(object?.balance_holder);
  // Объекты «АвД САО» и «ДЭУ N» ведёт их учётка: район их не снимает, даже если
  // они стоят на его территории.
  if (isAutodorHolder(object?.balance_holder)) return false;
  return sameDistrict(object?.district, user.district);
}

/**
 * Район, к которому объект относится в отчётности. Одно правило на штабную
 * таблицу, выгрузки и дашборд: объекты владельца «АвД САО», балансодержателей
 * «ДЭУ N» и объекты без района считаются за АвД, а не за районом, где стоят.
 */
export function reportingDistrict(object) {
  const district = String(object?.district ?? '').trim();
  if (!district || isAutodorHolder(object?.balanceHolder ?? object?.balance_holder)) return AUTODOR_HOLDER;
  return district;
}
