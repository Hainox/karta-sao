// Отчёт о состоянии отрисовки маршрутов на карте ОДХ.
//
// Модуль намеренно чистый: ни базы, ни сети, ни внешних зависимостей — только
// превращение уже собранных строк в отчёт, CSV и текст для Telegram. Так его
// можно проверять в изоляции, а запрос к БД живёт рядом, в repository.js.

// Словарь групп типов должен совпадать с odh-map/district-changes.js: маршруты —
// пять линейных типов, зона — только складирование роторного снега, всё
// остальное (включая неизвестный тип) попадает в точки. Своя копия нужна
// потому, что district-changes.js — браузерный IIFE над window и как чистый
// ES-модуль не грузится.
export const ROUTE_TYPES = new Set(['queue', 'rotor_transfer', 'dkm_route', 'tu_route', 'tu_route_yards']);
export const ZONE_TYPES = new Set(['rotor_snow_storage_zone']);

// Заголовок выгрузки: понятные русские названия без сокращений — файл открывают
// в Excel и читают без пояснений.
const CSV_HEADER = ['Район', 'Маршрутов', 'Зон', 'Точек', 'На приёмке', 'Утверждено', 'Отклонено', 'Последняя отправка'];
// Направление в фиксированной первой строке отчёта — та же шапка, что и в
// остальных рассылках заказчика.
const REPORT_DIRECTION = 'Отрисовка маршрутов ОДХ';

/** Группа объекта по типу: 'route' (маршрут), 'zone' (зона) или 'point' (точка). */
export function groupOf(changeType) {
  if (ROUTE_TYPES.has(changeType)) return 'route';
  if (ZONE_TYPES.has(changeType)) return 'zone';
  return 'point';
}

/** Момент времени в миллисекундах; пустое или некорректное значение — null. */
function momentOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.valueOf();
}

/** ISO-строка более позднего из двух моментов; null, если их нет. */
function laterOf(left, right) {
  const leftMs = momentOf(left);
  const rightMs = momentOf(right);
  if (leftMs === null) return rightMs === null ? null : new Date(rightMs).toISOString();
  if (rightMs === null) return new Date(leftMs).toISOString();
  return new Date(Math.max(leftMs, rightMs)).toISOString();
}

/** Дата и время «дд.мм.гггг чч:мм» для выгрузки; в России время местное. */
function formatMoment(value) {
  const ms = momentOf(value);
  if (ms === null) return '';
  const date = new Date(ms);
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function emptyDistrict(district) {
  return { district, routes: 0, zones: 0, points: 0, submitted: 0, approved: 0, rejected: 0, lastSubmittedAt: null };
}

/**
 * Свод по отрисовке маршрутов на карте ОДХ.
 *
 * Вход — rows: по одному объекту на каждую комбинацию «район + статус приёмки +
 * тип объекта», ровно как их отдаёт repository.routeReportRows():
 *   { district: string, status: 'submitted' | 'approved' | 'rejected',
 *     change_type: string, count: number, lastSubmittedAt: string | Date | null }
 * count — сколько объектов такого типа в наборах района с этим статусом;
 * lastSubmittedAt — время последней отправки набора района, одинаковое во всех
 * строках района. Группа объекта (маршрут/зона/точка) выводится из change_type.
 *
 * Выход:
 *   {
 *     generatedAt: string,            // ISO-момент формирования отчёта
 *     districts: [{ district, routes, zones, points,
 *                   submitted, approved, rejected, lastSubmittedAt }],
 *     totals: { routes, zones, points, submitted, approved, rejected, lastSubmittedAt },
 *     lagging: string[]               // районы без единого маршрута — с них спрос
 *   }
 * districtNames — полный список районов округа: районы без отправок попадут в
 * отчёт нулевыми строками и окажутся в lagging.
 * districts отсортирован по убыванию routes, затем по названию (русская локаль).
 * submitted/approved/rejected считают только маршруты; зоны и точки — отдельно.
 * lastSubmittedAt в итогах — самая поздняя отправка по САО.
 */
export function routeReport(rows, { generatedAt = new Date(), districtNames = [] } = {}) {
  const byDistrict = new Map();
  // Районы, которые ещё ничего не отправили, тоже обязаны попасть в отчёт: иначе
  // пустой список «без маршрутов» читался бы как «работа начата всеми».
  for (const name of Array.isArray(districtNames) ? districtNames : []) {
    if (!byDistrict.has(name)) byDistrict.set(name, emptyDistrict(name));
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const district = row.district;
    if (!byDistrict.has(district)) byDistrict.set(district, emptyDistrict(district));
    const item = byDistrict.get(district);
    const count = Number(row.count) || 0;
    const group = groupOf(row.change_type);
    if (group === 'route') {
      item.routes += count;
      if (row.status === 'submitted') item.submitted += count;
      else if (row.status === 'approved') item.approved += count;
      else if (row.status === 'rejected') item.rejected += count;
    } else if (group === 'zone') {
      item.zones += count;
    } else {
      item.points += count;
    }
    item.lastSubmittedAt = laterOf(item.lastSubmittedAt, row.lastSubmittedAt);
  }

  const districts = [...byDistrict.values()]
    .sort((left, right) => right.routes - left.routes || String(left.district).localeCompare(String(right.district), 'ru'));

  const totals = districts.reduce((acc, item) => ({
    routes: acc.routes + item.routes,
    zones: acc.zones + item.zones,
    points: acc.points + item.points,
    submitted: acc.submitted + item.submitted,
    approved: acc.approved + item.approved,
    rejected: acc.rejected + item.rejected,
    lastSubmittedAt: laterOf(acc.lastSubmittedAt, item.lastSubmittedAt)
  }), { routes: 0, zones: 0, points: 0, submitted: 0, approved: 0, rejected: 0, lastSubmittedAt: null });

  return {
    generatedAt: new Date(generatedAt).toISOString(),
    districts,
    totals,
    lagging: districts.filter((item) => item.routes === 0).map((item) => item.district)
  };
}

/**
 * CSV-выгрузка отчёта: UTF-8 с BOM, разделитель «;», строка «ИТОГО» в конце.
 * BOM и «;» нужны, чтобы русская версия Excel разложила строку по столбцам,
 * а числа остались целыми без разделителей разрядов.
 */
export function routeReportCsv(report) {
  const line = (values) => values.join(';');
  const lines = [line(CSV_HEADER)];
  for (const district of report.districts) {
    lines.push(line([
      district.district, district.routes, district.zones, district.points,
      district.submitted, district.approved, district.rejected, formatMoment(district.lastSubmittedAt)
    ]));
  }
  const totals = report.totals;
  lines.push(line([
    'ИТОГО', totals.routes, totals.zones, totals.points,
    totals.submitted, totals.approved, totals.rejected, formatMoment(totals.lastSubmittedAt)
  ]));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Имя файла выгрузки с датой отчёта: odh-routes-2026-09-16.csv. */
export function routeReportCsvName(report) {
  return `odh-routes-${String(report.generatedAt).slice(0, 10)}.csv`;
}

/**
 * Короткий текст для Telegram: фиксированная строка «Направление — проект —
 * дата и время», затем итоги, лидеры по числу маршрутов и районы без маршрутов.
 */
export function routeReportSummary(report) {
  const totals = report.totals;
  const leaders = report.districts.filter((item) => item.routes > 0).slice(0, 3);
  const lines = [
    `Направление — «${REPORT_DIRECTION}» — ${new Date(report.generatedAt).toLocaleString('ru-RU')}`,
    '',
    `Маршрутов на карте ОДХ: ${totals.routes}, зон: ${totals.zones}, точек: ${totals.points}.`,
    `На приёмке: ${totals.submitted}, утверждено: ${totals.approved}, отклонено: ${totals.rejected}.`
  ];
  if (leaders.length) lines.push(`Больше всего маршрутов: ${leaders.map((item) => `${item.district} — ${item.routes}`).join(', ')}.`);
  if (report.lagging.length) lines.push(`Без маршрутов: ${report.lagging.join(', ')}.`);
  else lines.push('Маршруты рисуют все районы.');
  return lines.join('\n');
}
