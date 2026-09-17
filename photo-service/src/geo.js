const EARTH_RADIUS_METERS = 6_371_008.8;
const DEFAULT_RADIUS_METERS = 15;
// Разброс ±15 м вокруг номинального радиуса: при таком допуске граница зоны
// получается 30 м, и фиксация ближе к объекту риском не считается.
const DEFAULT_TOLERANCE_METERS = 15;

/**
 * Точность, после которой позиция не считается спутниковой. Когда браузер не
 * получает спутники, он отдаёт точку по сети: одна координата на весь город и
 * точность в сотни километров. Такое нельзя ни принять, ни считать нарушением
 * зоны — расстояние до объекта в этом случае ничего не доказывает.
 */
export const UNUSABLE_ACCURACY_METERS = 500;

export function isUnusableAccuracy(accuracyMeters) {
  return Number.isFinite(accuracyMeters) && accuracyMeters > UNUSABLE_ACCURACY_METERS;
}

/**
 * Точность, после которой фиксация уходит на ручную проверку. Порог общий с
 * клиентом (`accuracyVerdict` в object-maps/photo-model.js).
 */
export const ACCURACY_REVIEW_METERS = 5;

/** Признак точности: ok / review / unusable / unknown — те же слова, что на клиенте. */
export function accuracyFlag(accuracyMeters) {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0) return 'unknown';
  if (isUnusableAccuracy(accuracyMeters)) return 'unusable';
  return accuracyMeters > ACCURACY_REVIEW_METERS ? 'review' : 'ok';
}

function coordinate(point, name) {
  if (point === null || typeof point !== 'object' || Array.isArray(point)) {
    throw new TypeError(name + ' must be a coordinate object');
  }
  const { latitude, longitude } = point;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new TypeError(name + '.latitude must be between -90 and 90');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new TypeError(name + '.longitude must be between -180 and 180');
  }
  return { latitude, longitude };
}

function radians(degrees) {
  return degrees * Math.PI / 180;
}

export function haversineDistanceMeters(firstPoint, secondPoint) {
  const first = coordinate(firstPoint, 'firstPoint');
  const second = coordinate(secondPoint, 'secondPoint');
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const firstLatitude = radians(first.latitude);
  const secondLatitude = radians(second.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;

  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/**
 * Compare a GPS fix to registered points using the nearest point only.
 * This is an approximation and must not be presented as polygon containment.
 * GPS accuracy policy is intentionally not inferred here; callers must keep
 * fixes without acceptable accuracy in manual review.
 */
export function assessDistanceRisk(
  position,
  referencePoints,
  radiusMeters = DEFAULT_RADIUS_METERS,
  toleranceMeters = DEFAULT_TOLERANCE_METERS,
) {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new TypeError('radiusMeters must be a positive finite number');
  }
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 0) {
    throw new TypeError('toleranceMeters must be a non-negative finite number');
  }
  if (position === null || position === undefined) {
    return { status: 'review', reason: 'missing_gps' };
  }
  if (!Array.isArray(referencePoints) || referencePoints.length === 0) {
    return { status: 'review', reason: 'missing_reference_points' };
  }

  const normalizedPosition = coordinate(position, 'position');
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestIndex = -1;
  referencePoints.forEach((referencePoint, index) => {
    const distance = haversineDistanceMeters(normalizedPosition, referencePoint);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  const effectiveRadiusMeters = radiusMeters + toleranceMeters;
  const risk = nearestDistance > effectiveRadiusMeters;
  const status = nearestDistance <= radiusMeters
    ? 'within_radius'
    : (risk ? 'risk' : 'within_tolerance');
  return {
    status,
    risk,
    distanceMeters: nearestDistance,
    radiusMeters,
    toleranceMeters,
    effectiveRadiusMeters,
    nominalRadiusExceeded: nearestDistance > radiusMeters,
    referencePointIndex: nearestIndex,
    approximation: 'nearest_registered_point',
  };
}

/**
 * Итог фиксации: расстояние до ближайшей зарегистрированной точки остаётся
 * справочной величиной, но статусом «риск» не помечается.
 *
 * GPS — не объективный показатель: часть районов снимает в плотной застройке,
 * где координаты уходят на 30+ метров, а часть работает без геолокации вовсе.
 * Поэтому фиксация без координат и фиксация далеко от точки одинаково уходят на
 * ручную проверку, а не запрещаются и не красятся «риском».
 */
export function photoGeoVerdict(distanceAssessment, accuracyMeters) {
  if (!distanceAssessment || typeof distanceAssessment !== 'object') {
    throw new TypeError('distanceAssessment must be the result of assessDistanceRisk');
  }
  const accuracy = accuracyFlag(accuracyMeters);
  const distanceReason = distanceAssessment.reason || null;
  const status = distanceAssessment.status === 'risk' ? 'review' : distanceAssessment.status;
  const reviewReason = distanceAssessment.risk
    ? 'far_from_registered_point'
    : (distanceReason === 'missing_gps' || distanceReason === 'missing_reference_points')
      ? distanceReason
      : accuracy === 'unknown'
        ? 'gps_accuracy_missing'
        : accuracy === 'review'
          ? 'gps_accuracy_above_5m'
          : distanceReason;
  return {
    status,
    distanceMeters: distanceAssessment.distanceMeters,
    accuracy,
    reviewReason,
  };
}
