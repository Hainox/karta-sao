const EARTH_RADIUS_METERS = 6_371_008.8;
const DEFAULT_RADIUS_METERS = 15;

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
export function assessDistanceRisk(position, referencePoints, radiusMeters = DEFAULT_RADIUS_METERS) {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new TypeError('radiusMeters must be a positive finite number');
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

  const risk = nearestDistance > radiusMeters;
  return {
    status: risk ? 'risk' : 'within_radius',
    risk,
    distanceMeters: nearestDistance,
    radiusMeters,
    referencePointIndex: nearestIndex,
    approximation: 'nearest_registered_point',
  };
}
