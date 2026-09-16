import { OBJECT_TYPES } from './labels.js';

// Штаб считает работу по владельцу объекта: «АвД САО» ведёт свои объекты отдельно
// от района, который их снимает. Туда же идут объекты с балансодержателем «ДЭУ»
// (в источнике ПП это ДЭУ 1, ДЭУ 2, ДЭУ 3) и объекты без района — приписать их
// конкретному району нельзя.
export const AUTODOR_HOLDER = 'АвД САО';

export function isAutodorHolder(holder) {
  const value = String(holder || '').trim();
  return value === AUTODOR_HOLDER || /^ДЭУ(\s|$)/i.test(value);
}

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

export function headquartersOverallPercent(counts) {
  return headquartersPercent(headquartersFactTotal(counts), headquartersPlanTotal(counts));
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
    const key = isAutodorHolder(item.balanceHolder) || !item.district ? AUTODOR_HOLDER : item.district;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const districts = [...grouped.keys()]
    .filter((name) => name !== AUTODOR_HOLDER)
    .sort((left, right) => left.localeCompare(right, 'ru'));
  const names = grouped.has(AUTODOR_HOLDER) ? [...districts, AUTODOR_HOLDER] : districts;
  const counts = names.map((name) => headquartersCounts(grouped.get(name)));
  const total = counts.reduce(addHeadquartersCounts, emptyHeadquartersCounts());
  // Нижняя таблица уходит в штаб: сверху лучшие по проценту «Итого». Одинаковые
  // проценты разводим по числу закрытых отметок, затем по названию — порядок
  // должен быть устойчивым, чтобы строки не «гуляли» между выгрузками.
  const sorted = names
    .map((name, index) => ({ name, counts: counts[index] }))
    .sort((left, right) => headquartersOverallPercent(right.counts) - headquartersOverallPercent(left.counts)
      || headquartersFactTotal(right.counts) - headquartersFactTotal(left.counts)
      || left.name.localeCompare(right.name, 'ru'));
  const lagging = names.filter((name, index) => headquartersFactTotal(counts[index]) === 0);
  return {
    names,
    counts,
    total,
    sorted,
    lagging,
    percent: headquartersOverallPercent(total),
  };
}

const TYPE_WORDS = Object.freeze({
  stop: 'остановки',
  pp: 'пешеходные переходы',
  entrance: 'подъезды',
});

function countText(value) {
  return Number(value).toLocaleString('ru-RU');
}

/**
 * Комментарий к выгрузке: не шаблон, а разбор текущих чисел — общий процент,
 * кто не начал, кто впереди и какая категория отстаёт сильнее остальных.
 * Строки одинаковой формы нужны, чтобы текст читался и в письме, и в картинке.
 */
export function headquartersComment(board) {
  const plan = headquartersPlanTotal(board.total);
  const fact = headquartersFactTotal(board.total);
  const percent = headquartersOverallPercent(board.total);
  const leaders = board.sorted
    .filter((item) => headquartersFactTotal(item.counts) > 0)
    .slice(0, 3);
  const categories = OBJECT_TYPES
    .map((kind) => ({
      kind,
      percent: headquartersPercent(board.total.fact[kind], board.total.plan[kind]),
      plan: board.total.plan[kind],
    }))
    .filter((item) => item.plan > 0)
    .sort((left, right) => left.percent - right.percent);

  const lines = [
    'Комментарий для рассылки (готов к отправке):',
    'Коллеги, добрый день!',
    `Оцифровка объектов САО: ${countText(fact)} из ${countText(plan)} отметок — ${percent} %.`,
  ];

  if (board.lagging.length) {
    lines.push('Слабая динамика по оцифровке объектов! Следующим районам срочно приступить к данной задаче:');
    lines.push(...board.lagging);
  } else {
    lines.push('Работа идёт во всех районах, отстающих нет.');
  }

  if (leaders.length) {
    const top = leaders.map((item) => `${item.name} — ${headquartersOverallPercent(item.counts)} %`).join(', ');
    lines.push(`Больше всего закрыто: ${top}.`);
  }

  if (categories.length) {
    const list = categories
      .map((item) => `${TYPE_WORDS[item.kind]} ${item.percent} %`)
      .join(', ');
    lines.push(`По категориям: ${list}.`);
    lines.push(`Слабее всего — ${TYPE_WORDS[categories[0].kind]} (${categories[0].percent} %).`);
  }

  return lines;
}
