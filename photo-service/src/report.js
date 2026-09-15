import { completionProgress, PHOTO_REQUIREMENTS } from './completion.js';

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

  return {
    requiredPhotos: PHOTO_REQUIREMENTS[record.objectType],
    confirmedPhotos,
    pendingReviewPhotos,
    geoRisk: record.geoRisk === true,
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
  };

  for (const record of records) {
    const {
      requiredPhotos,
      confirmedPhotos,
      pendingReviewPhotos,
      geoRisk,
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
