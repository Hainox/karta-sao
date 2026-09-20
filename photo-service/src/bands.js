/**
 * Светофор процентов: одна шкала на все выгрузки службы.
 *
 * Чем выше выполнение, тем «зеленее» заливка — от красного через оранжевый и
 * жёлтый к зелёному. Сто процентов дают истинный зелёный, семьдесят пять —
 * жёлтый, шестьдесят три — оранжевый, ниже пятидесяти — красный. Оттенки
 * подобраны бледными: смысл несёт число, цвет только помогает глазу.
 *
 * Ключи шкалы используются и как заливки Excel, и как цвета картинок и PDF,
 * поэтому пороги и цвета живут в одном месте — иначе слои разъезжаются.
 */
export const BANDS = Object.freeze([
  { key: 'zero', from: 0, to: 0, fill: 'FFEA9999', ink: 'FF8B1A1A', hex: '#EA9999', text: '#B3382B', label: 'Ноль' },
  { key: 'critical', from: 1, to: 24, fill: 'FFF4CCCC', ink: 'FFB3382B', hex: '#F4CCCC', text: '#B3382B', label: 'Красный' },
  { key: 'low', from: 25, to: 49, fill: 'FFF9DCD2', ink: 'FFB35A2B', hex: '#F9DCD2', text: '#C2512B', label: 'Красно-оранжевый' },
  { key: 'warning', from: 50, to: 62, fill: 'FFFCE4D6', ink: 'FF9A6A12', hex: '#FCE4D6', text: '#B36A12', label: 'Светло-оранжевый' },
  { key: 'orange', from: 63, to: 74, fill: 'FFF8CBAD', ink: 'FF8A4B12', hex: '#F8CBAD', text: '#9A6A12', label: 'Оранжевый' },
  { key: 'yellow', from: 75, to: 89, fill: 'FFFFEB9C', ink: 'FF7A5B00', hex: '#FFE699', text: '#8A6A00', label: 'Жёлтый' },
  { key: 'lightGreen', from: 90, to: 99, fill: 'FFC6EFCE', ink: 'FF1F6B3A', hex: '#C6EFCE', text: '#1C7A55', label: 'Светло-зелёный' },
  { key: 'green', from: 100, to: 100, fill: 'FF00B050', ink: 'FFFFFFFF', hex: '#00B050', text: '#0B7A3F', label: 'Зелёный' },
]);

const BY_KEY = new Map(BANDS.map((band) => [band.key, band]));

/**
 * Полоса светофора для процента. Без плана полосы нет: оценивать нечего,
 * поэтому возвращается null, а ячейка остаётся белой.
 */
export function bandFor(percent, plan) {
  if (!(Number(plan) > 0)) return null;
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return BANDS.find((band) => value >= band.from && value <= band.to) || BANDS[0];
}

export function bandByKey(key) {
  return BY_KEY.get(key) || null;
}

/** Цвет заливки ячейки для процента: белый, когда плана нет. */
export function bandFill(percent, plan) {
  const band = bandFor(percent, plan);
  return band ? band.fill : 'FFFFFFFF';
}

/**
 * Правила условного форматирования Excel — по одному на полосу. Цвет записан и
 * прямо в ячейку, но правила продолжают работать, когда данные правят в книге.
 */
export function percentBandRules(cell, plan, band) {
  const ranges = [];
  if (band.from === 0 && band.to === 0) ranges.push(`${cell}<=0`);
  else if (band.from === 100) ranges.push(`${cell}>=100`);
  else ranges.push(`AND(${cell}>=${band.from},${cell}<=${band.to})`);
  return ranges.map((when) => ({
    type: 'expression',
    formulae: [`AND(${plan}>0,ISNUMBER(${cell}),${when})`],
    style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: band.fill } } },
  }));
}
