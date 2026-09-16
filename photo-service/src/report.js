import { completionProgress, PHOTO_REQUIREMENTS } from './completion.js';
import { AUTODOR_HOLDER, reportingDistrict } from './scope.js';

const OBJECT_TYPES = new Set(Object.keys(PHOTO_REQUIREMENTS));

function requiredCount(record, name) {
  const value = record[name];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(name + ' must be a non-negative safe integer');
  }
  return value;
}

function validateRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Each coverage record must be an object');
  }
  if (!OBJECT_TYPES.has(record.objectType)) {
    throw new TypeError('objectType must be stop, pp, or entrance');
  }

  const confirmedPhotos = requiredCount(record, 'confirmedPhotos');
  const pendingReviewPhotos = requiredCount(record, 'pendingReviewPhotos');
  if (record.geoRisk !== undefined && typeof record.geoRisk !== 'boolean') {
    throw new TypeError('geoRisk must be a boolean');
  }

  const sourcePointCount = Number.isSafeInteger(record.sourcePointCount) && record.sourcePointCount > 0
    ? record.sourcePointCount
    : 0;
  const coveredPoints = Number.isSafeInteger(record.coveredPoints) && record.coveredPoints > 0
    ? Math.min(record.coveredPoints, sourcePointCount || record.coveredPoints)
    : 0;

  return {
    requiredPhotos: PHOTO_REQUIREMENTS[record.objectType],
    confirmedPhotos,
    pendingReviewPhotos,
    geoRisk: record.geoRisk === true,
    sourcePointCount,
    coveredPoints,
  };
}

/**
 * Summarize one already-scoped report set.
 *
 * Pending photos count as "with photo" but never as confirmed completion.
 * An object is classified as pending_review when it is not complete and has
 * any pending photo. Partial means at least one confirmed photo is present but
 * the approved norm is not met. Pending and partial counters are deliberately
 * independent so a review queue is never hidden by a completed object.
 */
export function summarizeCoverage(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Coverage records must be an array');
  }

  const summary = {
    totalObjects: records.length,
    objectsWithPhoto: 0,
    objectsWithoutPhoto: 0,
    completedObjects: 0,
    partialObjects: 0,
    pendingReviewObjects: 0,
    geoRiskObjects: 0,
    totalPoints: 0,
    coveredPoints: 0,
    pointsWithoutPhoto: 0,
  };

  for (const record of records) {
    const {
      requiredPhotos,
      confirmedPhotos,
      pendingReviewPhotos,
      geoRisk,
      sourcePointCount,
      coveredPoints,
    } = validateRecord(record);
    const hasPhoto = confirmedPhotos + pendingReviewPhotos > 0;
    const complete = confirmedPhotos >= requiredPhotos;

    if (hasPhoto) {
      summary.objectsWithPhoto += 1;
    } else {
      summary.objectsWithoutPhoto += 1;
    }

    if (complete) {
      summary.completedObjects += 1;
    }
    if (pendingReviewPhotos > 0) {
      summary.pendingReviewObjects += 1;
    }
    if (!complete && confirmedPhotos > 0) {
      summary.partialObjects += 1;
    }

    if (geoRisk) {
      summary.geoRiskObjects += 1;
    }

    // Точки источника: единица работы района — конкретная точка на карте.
    summary.totalPoints += sourcePointCount;
    summary.coveredPoints += coveredPoints;
    summary.pointsWithoutPhoto += Math.max(0, sourcePointCount - coveredPoints);
  }

  const progress = completionProgress(summary.completedObjects, summary.totalObjects);
  return {
    ...summary,
    completionPercent: progress.completionPercent,
    statusBand: progress.band,
  };
}

/**
 * Return the same summary separately for each supported object type.
 * The caller is responsible for applying the desired district or SAO scope
 * before passing records here; no unassigned-object denominator is inferred.
 */
export function summarizeCoverageByType(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Coverage records must be an array');
  }

  const grouped = {
    stop: [],
    pp: [],
    entrance: [],
  };

  for (const record of records) {
    validateRecord(record);
    grouped[record.objectType].push(record);
  }

  return {
    stop: summarizeCoverage(grouped.stop),
    pp: summarizeCoverage(grouped.pp),
    entrance: summarizeCoverage(grouped.entrance),
  };
}

function coverageRecord(row) {
  return {
    objectType: row.object_type,
    confirmedPhotos: row.confirmedPhotos,
    pendingReviewPhotos: row.pendingReviewPhotos,
    geoRisk: row.geoRisk,
  };
}

/**
 * Охват по районам для отчёта: те же числа, что и в таблицах, идут на график.
 * Район строки определяется правилом отчётности `reportingDistrict`: объекты
 * владельца «АвД САО», балансодержателей «ДЭУ N» и объекты без района считаются
 * за строку «АвД САО», а не за район, где стоят. Поэтому в разрезе района
 * «Без района» не остаётся, а строка «АвД САО» всегда последняя.
 */
export function summarizeByDistrict(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Report rows must be an array');
  const grouped = new Map();
  for (const row of rows) {
    const district = reportingDistrict(row);
    if (!grouped.has(district)) grouped.set(district, []);
    grouped.get(district).push(coverageRecord(row));
  }
  return [...grouped.entries()]
    .map(([district, records]) => ({ district, ...summarizeCoverage(records) }))
    .sort((left, right) => {
      // «АвД САО» — не район: объём владельца всегда последней строкой.
      if ((left.district === AUTODOR_HOLDER) !== (right.district === AUTODOR_HOLDER)) {
        return left.district === AUTODOR_HOLDER ? 1 : -1;
      }
      return (right.completionPercent ?? -1) - (left.completionPercent ?? -1)
        || left.district.localeCompare(right.district, 'ru');
    });
}

/**
 * Photos uploaded per calendar day (UTC) over the trailing window, with the
 * running total that starts from everything uploaded before the window.
 */
export function uploadDynamics(rows, { days = 14, now = new Date() } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('Report rows must be an array');
  if (!Number.isSafeInteger(days) || days < 1) throw new TypeError('days must be a positive integer');

  const perDay = new Map();
  for (const row of rows) {
    for (const photo of row.photos || []) {
      if (!photo.uploadedAt) continue;
      const stamp = new Date(photo.uploadedAt);
      if (Number.isNaN(stamp.getTime())) continue;
      const key = stamp.toISOString().slice(0, 10);
      perDay.set(key, (perDay.get(key) || 0) + 1);
    }
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date(now);
  const series = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * dayMs).toISOString().slice(0, 10);
    series.push({ date, uploaded: perDay.get(date) || 0 });
  }

  const first = series[0].date;
  let cumulative = 0;
  for (const [date, count] of perDay) if (date < first) cumulative += count;
  for (const point of series) {
    cumulative += point.uploaded;
    point.cumulative = cumulative;
  }
  return series;
}

/**
 * Split the object states for the stacked bar: a completed object is not counted
 * as partial, and pending stays visible on its own.
 */
export function completionMix(summary) {
  if (!summary || typeof summary !== 'object') throw new TypeError('summary is required');
  const completed = summary.completedObjects ?? 0;
  const partial = summary.partialObjects ?? 0;
  const total = summary.totalObjects ?? 0;
  return [
    { key: 'done', label: 'Выполнено', value: completed },
    { key: 'partial', label: 'Частично', value: partial },
    { key: 'empty', label: 'Без фото', value: Math.max(0, total - completed - partial) },
  ];
}
