import { dayKey, REPORT_TIME_ZONE } from './report.js';
import { reportingDistrict } from './scope.js';
import { OBJECT_TYPES } from './labels.js';
import { headquartersBoard } from './headquarters.js';
import { reportPayload } from './reports.js';

/**
 * Единый отчёт по продуктивности округа за день.
 *
 * День считается по московскому времени: рабочий день округа — МСК, а не UTC.
 * Все числа выводятся из одной выборки отчёта (`loadReportRows`), поэтому отчёт
 * за день не расходится со сводкой, «На штаб» и выгрузками.
 */

/** Смещение зоны в минутах на конкретный момент (учитывает переходы времени). */
function zoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second'));
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Границы календарного дня в заданной зоне: `[начало, конец)`. */
export function dailyWindow(now = new Date(), timeZone = REPORT_TIME_ZONE) {
  const date = dayKey(now, timeZone);
  if (!date) throw new TypeError('now must be a valid date');
  const [year, month, day] = date.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const start = new Date(utcMidnight - zoneOffsetMinutes(new Date(utcMidnight), timeZone) * 60000);
  const nextUtcMidnight = utcMidnight + 24 * 60 * 60 * 1000;
  const end = new Date(nextUtcMidnight - zoneOffsetMinutes(new Date(nextUtcMidnight), timeZone) * 60000);
  return { date, start, end };
}

function inWindow(value, window) {
  if (!value) return false;
  const stamp = new Date(value);
  if (Number.isNaN(stamp.getTime())) return false;
  return stamp >= window.start && stamp < window.end;
}

// Отметка — конкретная точка на карте: один объект ОДХ может иметь их десятки,
// и подтверждение считается по точке, как во всей остальной отчётности.
function pointKey(row, photo) {
  return `${row.object_key}|${photo.sourceId ?? ''}`;
}

function emptyTypeCounts() {
  return Object.fromEntries(OBJECT_TYPES.map((type) => [type, { uploaded: 0, closed: 0 }]));
}

/**
 * Дневной срез: что сделано за день по районам, видам объектов и исполнителям,
 * плюс динамика за окно и лучшие/худшие. `rows` — выборка `loadReportRows`.
 */
export function dailyReport(rows, { now = new Date(), days = 14, timeZone = REPORT_TIME_ZONE, limit = 3 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!Number.isSafeInteger(days) || days < 2) throw new TypeError('days must be an integer of at least 2');
  const window = dailyWindow(now, timeZone);

  const perDay = new Map();
  const districts = new Map();
  const performers = new Map();
  const types = emptyTypeCounts();
  const closedPoints = new Set();
  let uploadedToday = 0;
  let closedToday = 0;
  let pendingToday = 0;

  const districtRow = (name) => {
    if (!districts.has(name)) {
      districts.set(name, { district: name, uploaded: 0, closed: 0, pending: 0, points: new Set() });
    }
    return districts.get(name);
  };

  const bucketFor = (day) => {
    if (!perDay.has(day)) perDay.set(day, { uploaded: 0, closed: 0 });
    return perDay.get(day);
  };

  for (const row of rows) {
    const name = reportingDistrict(row);
    for (const photo of row.photos || []) {
      const uploaded = inWindow(photo.uploadedAt, window);
      const confirmed = photo.reviewStatus === 'confirmed' && inWindow(photo.reviewedAt, window);
      // В дневную серию входят все дни окна, а не только сегодняшний: загрузка
      // считается по дате съёмки, подтверждение — по дате проверки.
      const uploadDay = dayKey(photo.uploadedAt, timeZone);
      if (uploadDay) bucketFor(uploadDay).uploaded += 1;
      if (photo.reviewStatus === 'confirmed') {
        const closeDay = dayKey(photo.reviewedAt, timeZone);
        if (closeDay) bucketFor(closeDay).closed += 1;
      }
      if (!uploaded && !confirmed) continue;

      const entry = districtRow(name);
      if (uploaded) {
        uploadedToday += 1;
        entry.uploaded += 1;
        types[row.object_type].uploaded += 1;
        if (photo.reviewStatus === 'pending_review') { pendingToday += 1; entry.pending += 1; }
        const performer = String(photo.performer || '').trim() || 'Исполнитель не указан';
        const key = `${name}|${performer}`;
        if (!performers.has(key)) performers.set(key, { performer, district: name, uploaded: 0 });
        performers.get(key).uploaded += 1;
      }
      if (confirmed) {
        closedToday += 1;
        entry.closed += 1;
        types[row.object_type].closed += 1;
        entry.points.add(pointKey(row, photo));
      }
    }
  }

  // Динамика: дни окна по МСК, начиная с самого раннего.
  const [year, month, day] = window.date.split('-').map(Number);
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDay = Date.UTC(year, month - 1, day) - (days - 1) * dayMs;
  const dynamics = [];
  let cumulative = 0;
  const firstKey = dayKey(new Date(firstDay), timeZone);
  for (const [date, bucket] of perDay) {
    if (date < firstKey) cumulative += bucket.uploaded;
  }
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(firstDay + offset * dayMs).toISOString().slice(0, 10);
    const bucket = perDay.get(date) || { uploaded: 0, closed: 0 };
    cumulative += bucket.uploaded;
    dynamics.push({ date, uploaded: bucket.uploaded, closed: bucket.closed, cumulative });
  }

  const payload = reportPayload(rows);
  const board = headquartersBoard(payload);
  // Проценты берём из того же модуля, что штабная таблица: своих формул здесь нет.
  const percentByName = new Map(board.names.map((name, index) => [name, overallPercent(board.counts[index])]));

  const districtRows = [...districts.values()].map((entry) => ({
    district: entry.district,
    uploaded: entry.uploaded,
    closed: entry.closed,
    pending: entry.pending,
    closedPoints: entry.points.size,
    cumulativePercent: percentByName.get(entry.district) ?? 0,
  }));
  const sortedBest = districtRows.slice().sort((left, right) => right.closed - left.closed
    || right.uploaded - left.uploaded
    || left.district.localeCompare(right.district, 'ru'));
  const silent = board.names.filter((name) => !(districts.get(name)?.uploaded));
  const worst = silent
    .map((name) => ({ district: name, cumulativePercent: percentByName.get(name) ?? 0 }))
    .sort((left, right) => left.cumulativePercent - right.cumulativePercent
      || left.district.localeCompare(right.district, 'ru'));

  const yesterday = dynamics[dynamics.length - 2] || { uploaded: 0, closed: 0 };
  const week = dynamics.slice(-8, -1);
  const average = (key) => (week.length ? Math.round((week.reduce((sum, point) => sum + point[key], 0) / week.length) * 10) / 10 : 0);

  return {
    generatedAt: now.toISOString(),
    date: window.date,
    window: { start: window.start.toISOString(), end: window.end.toISOString(), timeZone },
    overall: {
      uploaded: uploadedToday,
      closed: closedToday,
      pending: pendingToday,
      activeDistricts: [...districts.values()].filter((entry) => entry.uploaded > 0).length,
      activePerformers: performers.size,
      totalDistricts: board.names.length,
      cumulativePercent: board.percent,
    },
    deltas: {
      uploadedVsYesterday: uploadedToday - yesterday.uploaded,
      uploadedVsWeekAverage: uploadedToday - average('uploaded'),
      closedVsYesterday: closedToday - yesterday.closed,
      closedVsWeekAverage: closedToday - average('closed'),
      weekAverageUploaded: average('uploaded'),
      weekAverageClosed: average('closed'),
    },
    dynamics,
    districts: districtRows.slice().sort((left, right) => right.uploaded - left.uploaded
      || right.closed - left.closed
      || left.district.localeCompare(right.district, 'ru')),
    types: OBJECT_TYPES.map((type) => ({ objectType: type, ...types[type] })),
    performers: [...performers.values()].sort((left, right) => right.uploaded - left.uploaded
      || left.district.localeCompare(right.district, 'ru')
      || left.performer.localeCompare(right.performer, 'ru')),
    leaders: { best: sortedBest.filter((entry) => entry.closed > 0 || entry.uploaded > 0).slice(0, limit), worst: worst.slice(0, limit), silent },
    // Объекты без района префектура видит списком: привязку не меняем, но имена
    // нужны — иначе «7 объектов» останутся числом без источников.
    unassigned: {
      total: payload.unassigned.totalObjects,
      objects: payload.unassigned.objects || [],
      listLimit: payload.unassigned.listLimit,
    },
  };
}

// Процент «Итого» строки района считается тем же правилом, что в штабной таблице.
function overallPercent(counts) {
  const plan = counts.plan.stop + counts.plan.pp + counts.plan.entrance;
  const fact = counts.fact.stop + counts.fact.pp + counts.fact.entrance;
  return plan ? Math.round((fact / plan) * 100) : 0;
}

const TYPE_WORDS = Object.freeze({ stop: 'остановки', pp: 'пешеходные переходы', entrance: 'подъезды' });

const numberText = (value) => Number(value || 0).toLocaleString('ru-RU');
const deltaText = (value) => `${value > 0 ? '+' : ''}${numberText(value)}`;

/**
 * Сколько миллисекунд осталось до ближайшего запуска в заданное время по МСК.
 * Окно считается по московским суткам: расписание не должно зависеть от UTC.
 */
export function msUntilDailyRun(now, at = '19:00', timeZone = REPORT_TIME_ZONE) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(at).trim());
  if (!match) throw new TypeError('at must be a time in HH:MM form');
  const date = dayKey(now, timeZone);
  if (!date) throw new TypeError('now must be a valid date');
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes] = match.slice(1).map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const offset = zoneOffsetMinutes(new Date(utcMidnight), timeZone);
  const target = utcMidnight + (hours * 60 + minutes) * 60000 - offset * 60000;
  const moment = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  return target > moment ? target - moment : target + dayMs - moment;
}

/** Текст дневной сводки: первая строка фиксированная, дальше — разбор дня. */
export function dailyComment(report, { generatedAt = new Date() } = {}) {
  const { overall, deltas, leaders } = report;
  const lines = [
    `Направление — «Единый отчёт по продуктивности округа за день» — ${generatedAt.toLocaleString('ru-RU')} (МСК)`,
    '',
    'Коллеги, добрый день!',
    `За ${report.date} загружено ${numberText(overall.uploaded)} фото (${deltaText(deltas.uploadedVsYesterday)} к вчерашнему дню), подтверждено ${numberText(overall.closed)} отметок (${deltaText(deltas.closedVsYesterday)}).`,
    `В работе участвовали ${overall.activeDistricts} из ${overall.totalDistricts} районов, исполнителей — ${overall.activePerformers}. На проверке за день: ${numberText(overall.pending)}.`,
    `Средний день за неделю: ${numberText(deltas.weekAverageUploaded)} фото и ${numberText(deltas.weekAverageClosed)} подтверждённых отметок.`,
    `Всего по округу закрыто ${overall.cumulativePercent} % отметок.`,
  ];

  if (leaders.best.length) {
    lines.push(`Лучшие за день: ${leaders.best.map((entry) => `${entry.district} — ${numberText(entry.closed)} подтверждено, ${numberText(entry.uploaded)} загружено`).join('; ')}.`);
  }
  if (leaders.worst.length) {
    lines.push(`Слабый день: ${leaders.worst.map((entry) => `${entry.district} (${entry.cumulativePercent} % за всё время)`).join('; ')}.`);
  }
  if (leaders.silent.length) {
    lines.push(`Без загрузок за день: ${leaders.silent.join(', ')}.`);
  }
  return lines;
}
