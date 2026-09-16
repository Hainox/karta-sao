import { OBJECT_TYPES } from './labels.js';

// Штаб считает работу по владельцу объекта: «АвД САО» ведёт свои объекты отдельно
// от района, который их снимает. Объекты без района тоже идут сюда — приписать их
// конкретному району нельзя.
export const AUTODOR_HOLDER = 'АвД САО';

// Единица учёта — отметка, то есть конкретная точка на карте, а не уникальный
// объект: у одного перехода точек может быть несколько десятков, и снимается каждая.
function marks(item) {
  const plan = Math.max(0, Number(item.sourcePointCount) || 0);
  const covered = Math.max(0, Number(item.coveredPoints) || 0);
  return { plan, fact: Math.min(covered, plan) };
}

export function emptyHeadquartersCounts() {
  return { plan: { stop: 0, pp: 0, entrance: 0 }, fact: { stop: 0, pp: 0, entrance: 0 } };
}

export function headquartersCounts(items) {
  const counts = emptyHeadquartersCounts();
  for (const item of items) {
    const value = marks(item);
    counts.plan[item.objectType] += value.plan;
    counts.fact[item.objectType] += value.fact;
  }
  return counts;
}

export function addHeadquartersCounts(target, counts) {
  for (const kind of OBJECT_TYPES) {
    target.plan[kind] += counts.plan[kind];
    target.fact[kind] += counts.fact[kind];
  }
  return target;
}

export function headquartersPlanTotal(counts) {
  return counts.plan.stop + counts.plan.pp + counts.plan.entrance;
}

export function headquartersFactTotal(counts) {
  return counts.fact.stop + counts.fact.pp + counts.fact.entrance;
}

// Процент есть всегда и целым числом: без плана это ноль, а не пустая ячейка —
// иначе в таблице «пропадают» числа. Десятые доли не показываем.
export function headquartersPercent(fact, plan) {
  return plan ? Math.round((fact / plan) * 100) : 0;
}

export function headquartersValues(counts) {
  const values = [];
  for (const kind of OBJECT_TYPES) {
    values.push(counts.plan[kind], counts.fact[kind], headquartersPercent(counts.fact[kind], counts.plan[kind]));
  }
  const plan = headquartersPlanTotal(counts);
  const fact = headquartersFactTotal(counts);
  values.push(plan, fact, headquartersPercent(fact, plan));
  return values;
}

/**
 * Числа листа «На штаб» и картинки для Telegram: строки районов, строка «АвД САО»,
 * итог по САО, та же таблица в порядке по «Итого: факт» и районы без закрытых
 * отметок. Одна модель — чтобы лист и картинка не расходились.
 */
export function headquartersBoard(payload) {
  const grouped = new Map();
  for (const item of payload.objects) {
    const holder = (item.balanceHolder || '').trim();
    const key = holder === AUTODOR_HOLDER || !item.district ? AUTODOR_HOLDER : item.district;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const districts = [...grouped.keys()]
    .filter((name) => name !== AUTODOR_HOLDER)
    .sort((left, right) => left.localeCompare(right, 'ru'));
  const names = grouped.has(AUTODOR_HOLDER) ? [...districts, AUTODOR_HOLDER] : districts;
  const counts = names.map((name) => headquartersCounts(grouped.get(name)));
  const total = counts.reduce(addHeadquartersCounts, emptyHeadquartersCounts());
  const sorted = names
    .map((name, index) => ({ name, counts: counts[index] }))
    .sort((left, right) => headquartersFactTotal(right.counts) - headquartersFactTotal(left.counts)
      || left.name.localeCompare(right.name, 'ru'));
  const lagging = names.filter((name, index) => headquartersFactTotal(counts[index]) === 0);
  return {
    names,
    counts,
    total,
    sorted,
    lagging,
    percent: headquartersPercent(headquartersFactTotal(total), headquartersPlanTotal(total)),
  };
}

/** Готовый текст для рассылки: районы, где не закрыто ни одной отметки. */
export function headquartersComment(lagging) {
  return lagging.length
    ? [
      'Комментарий для рассылки (готов к отправке):',
      'Коллеги, добрый день!',
      'Слабая динамика по оцифровке объектов!',
      'Следующим районам срочно приступить к данной задаче:',
      ...lagging,
    ]
    : [
      'Комментарий для рассылки (готов к отправке):',
      'Коллеги, добрый день!',
      'Оцифровка объектов идёт во всех районах, отстающих нет.',
    ];
}
