import crypto from 'node:crypto';

export const DISTRICTS = new Set([
  'Аэропорт', 'Беговой', 'Бескудниковский', 'Войковский', 'Восточное Дегунино',
  'Головинский', 'Дмитровский', 'Западное Дегунино', 'Коптево', 'Левобережный',
  'Молжаниновский', 'Савеловский', 'Сокол', 'Тимирязевский', 'Ховрино', 'Хорошевский',
  // АвД САО рисует маршруты наравне с районами: у неё та же роль редактора и своя
  // строка в приёмке и выгрузках.
  'АвД САО'
]);

export const TYPES = {
  queue: 'LineString',
  rotor_transfer: 'LineString',
  dkm_route: 'LineString',
  tu_route: 'LineString',
  tu_route_yards: 'LineString',
  temporary_snow_storage: 'Point',
  rotor_snow_storage_zone: 'Polygon',
  dry_snow_dump: 'Point',
  pgm: 'Point',
  smm_storage: 'Point',
  other: 'Point'
};

const ROUTE_TYPES = new Set(['queue', 'rotor_transfer', 'dkm_route', 'tu_route', 'tu_route_yards']);
const SEGMENT_EPSILON = 1e-12;

function coordinate(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function sameCoordinate(first, second) {
  return coordinate(first) && coordinate(second) && first[0] === second[0] && first[1] === second[1];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    const intersects = ((y > point[1]) !== (previousY > point[1])) &&
      (point[0] < (previousX - x) * (point[1] - y) / (previousY - y) + x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonCoordinates(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  return [];
}

function boundaryPolygons(boundary) {
  const features = boundary?.features || [];
  const saoBoundary = features.find((feature) => feature?.properties?.feature_kind === 'boundary_sao');
  return (saoBoundary ? [saoBoundary] : features).flatMap((feature) => polygonCoordinates(feature?.geometry));
}

function boundarySegments(polygons) {
  const segments = [];
  for (const polygon of polygons) {
    for (const ring of polygon || []) {
      if (!Array.isArray(ring)) continue;
      for (let index = 1; index < ring.length; index++) {
        const start = ring[index - 1];
        const end = ring[index];
        if (!coordinate(start) || !coordinate(end)) continue;
        segments.push({
          start,
          end,
          minX: Math.min(start[0], end[0]),
          maxX: Math.max(start[0], end[0]),
          minY: Math.min(start[1], end[1]),
          maxY: Math.max(start[1], end[1])
        });
      }
    }
  }
  return segments;
}

function orientation(first, second, third) {
  return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function onSegment(first, second, point) {
  return Math.abs(orientation(first, second, point)) <= SEGMENT_EPSILON &&
    point[0] >= Math.min(first[0], second[0]) - SEGMENT_EPSILON && point[0] <= Math.max(first[0], second[0]) + SEGMENT_EPSILON &&
    point[1] >= Math.min(first[1], second[1]) - SEGMENT_EPSILON && point[1] <= Math.max(first[1], second[1]) + SEGMENT_EPSILON;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const first = orientation(firstStart, firstEnd, secondStart);
  const second = orientation(firstStart, firstEnd, secondEnd);
  const third = orientation(secondStart, secondEnd, firstStart);
  const fourth = orientation(secondStart, secondEnd, firstEnd);
  if ((first > SEGMENT_EPSILON && second < -SEGMENT_EPSILON || first < -SEGMENT_EPSILON && second > SEGMENT_EPSILON) &&
    (third > SEGMENT_EPSILON && fourth < -SEGMENT_EPSILON || third < -SEGMENT_EPSILON && fourth > SEGMENT_EPSILON)) return true;
  return Math.abs(first) <= SEGMENT_EPSILON && onSegment(firstStart, firstEnd, secondStart) ||
    Math.abs(second) <= SEGMENT_EPSILON && onSegment(firstStart, firstEnd, secondEnd) ||
    Math.abs(third) <= SEGMENT_EPSILON && onSegment(secondStart, secondEnd, firstStart) ||
    Math.abs(fourth) <= SEGMENT_EPSILON && onSegment(secondStart, secondEnd, firstEnd);
}

function segmentWithinBoundary(start, end, segments) {
  if (!coordinate(start) || !coordinate(end)) return false;
  for (const boundarySegment of segments) {
    if (Math.max(start[0], end[0]) < boundarySegment.minX - SEGMENT_EPSILON ||
      Math.min(start[0], end[0]) > boundarySegment.maxX + SEGMENT_EPSILON ||
      Math.max(start[1], end[1]) < boundarySegment.minY - SEGMENT_EPSILON ||
      Math.min(start[1], end[1]) > boundarySegment.maxY + SEGMENT_EPSILON) continue;
    if (segmentsIntersect(start, end, boundarySegment.start, boundarySegment.end)) return false;
  }
  return true;
}

function polygonContainsPoint(point, rings) {
  return Array.isArray(rings) && Array.isArray(rings[0]) && pointInRing(point, rings[0]) &&
    !rings.slice(1).some((ring) => Array.isArray(ring) && pointInRing(point, ring));
}

function polygonContainsBoundaryHole(geometry, polygons) {
  return polygons.some((polygon) => (polygon || []).slice(1).some((ring) =>
    Array.isArray(ring) && ring.length && polygonContainsPoint(ring[0], geometry.coordinates)));
}

function containsPoint(point, boundary) {
  if (!coordinate(point) || !boundary?.features) return false;
  return boundaryPolygons(boundary).some((polygon) => polygonInBoundary(point, polygon));
}

function polygonInBoundary(point, polygon) {
  return Array.isArray(polygon) && Array.isArray(polygon[0]) && pointInRing(point, polygon[0]) &&
    !polygon.slice(1).some((ring) => Array.isArray(ring) && pointInRing(point, ring));
}

export function isPointWithinBoundary(point, boundary) {
  return containsPoint(point, boundary);
}

function geometryCoordinates(geometry) {
  if (geometry?.type === 'Point') return [geometry.coordinates];
  if (geometry?.type === 'LineString') return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  if (geometry?.type === 'Polygon') return Array.isArray(geometry.coordinates) ? geometry.coordinates.flatMap((ring) => Array.isArray(ring) ? ring : [ring]) : [];
  return [];
}

function geometrySegments(geometry) {
  const rings = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'Polygon' ? geometry.coordinates : [];
  return (Array.isArray(rings) ? rings : []).flatMap((ring) => {
    if (!Array.isArray(ring)) return [];
    return ring.slice(1).map((end, index) => [ring[index], end]);
  });
}

function ringsAreClosedAndValid(rings) {
  return Array.isArray(rings) && rings.length > 0 && rings.every((ring) =>
    Array.isArray(ring) && ring.length >= 4 && JSON.stringify(ring[0]) === JSON.stringify(ring.at(-1)));
}

function routeDuplicateKey(feature) {
  const properties = feature?.properties || {};
  if (!ROUTE_TYPES.has(properties.change_type) || feature?.geometry?.type !== 'LineString' || !Array.isArray(feature.geometry.coordinates)) return null;
  const coordinates = feature.geometry.coordinates;
  const forward = JSON.stringify(coordinates);
  const reverse = JSON.stringify([...coordinates].reverse());
  const routeClass = `${properties.change_type}:${properties.change_type === 'queue' ? properties.queue_priority : ''}`;
  return `${routeClass}:${forward < reverse ? forward : reverse}`;
}

export function validateChangeSet(changeSet, boundary) {
  const errors = [];
  if (!changeSet || changeSet.type !== 'FeatureCollection') errors.push('Нужен GeoJSON типа FeatureCollection.');
  if (changeSet?.change_set_version !== 'district_change_set_v2') errors.push('Ожидается формат district_change_set_v2.');
  if (!DISTRICTS.has(changeSet?.district)) errors.push('Укажите корректный район САО.');
  if (typeof changeSet?.author !== 'string' || !changeSet.author.trim()) errors.push('Укажите исполнителя.');
  if (!Array.isArray(changeSet?.features) || !changeSet.features.length) errors.push('Нужно добавить хотя бы один объект.');
  const features = Array.isArray(changeSet?.features) ? changeSet.features : [];
  const routes = new Map();
  features.forEach((feature, index) => {
    const key = routeDuplicateKey(feature);
    if (key === null) return;
    const properties = feature?.properties || {};
    const number = Number.isSafeInteger(properties.object_no) && properties.object_no > 0 ? properties.object_no : index + 1;
    if (routes.has(key)) errors.push(`Маршрут ${number} дублирует маршрут ${routes.get(key)} в этом наборе; удалите повтор.`);
    else routes.set(key, number);
  });

  const polygons = boundaryPolygons(boundary);
  const edges = boundarySegments(polygons);
  for (const [index, feature] of features.entries()) {
    const properties = feature?.properties || {};
    const expectedGeometry = TYPES[properties.change_type];
    // Номер объекта: собственный номер из набора, если он есть, иначе позиция в файле.
    const number = Number.isSafeInteger(properties.object_no) && properties.object_no > 0 ? properties.object_no : index + 1;
    if (!feature || feature.type !== 'Feature' || !feature.geometry) { errors.push(`Объект ${number}: повреждён.`); continue; }
    // Тип могли убрать из словаря после того, как объект нарисовали: район должен
    // увидеть причину, а не общее «неверная геометрия».
    if (!expectedGeometry) errors.push(`Объект ${number}: тип «${properties.change_type ?? 'не указан'}» не поддерживается.`);
    else if (feature.geometry.type !== expectedGeometry) errors.push(`Объект ${number}: неверная геометрия для выбранного типа.`);
    if (properties.district !== changeSet.district || properties.author !== changeSet.author) errors.push(`Объект ${number}: карточка объекта не совпадает с набором.`);
    if (typeof properties.address !== 'string' || !properties.address.trim()) errors.push(`Объект ${number}: укажите адрес или ориентир.`);
    if (properties.change_type === 'queue' && !['1', '2', '3'].includes(String(properties.queue_priority))) errors.push(`Объект ${number}: очередь должна быть 1, 2 или 3.`);
    if (ROUTE_TYPES.has(properties.change_type) && feature.geometry.type === 'LineString') {
      const points = Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [];
      if (!sameCoordinate(properties.route_start, points[0]) || !sameCoordinate(properties.route_end, points.at(-1))) errors.push(`Объект ${number}: начало и конец маршрута должны быть явно заданы.`);
      if (properties.route_direction !== 'start_to_end') errors.push(`Объект ${number}: направление маршрута повреждено.`);
      if (!['left', 'right', 'both'].includes(properties.nozzle_direction)) errors.push(`Объект ${number}: направление сопла — left, right или both.`);
    }
    if (feature.geometry.type === 'LineString' && (!Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length < 2)) errors.push(`Объект ${number}: маршрут должен содержать минимум две точки.`);
    if (feature.geometry.type === 'Polygon') {
      if (!ringsAreClosedAndValid(feature.geometry.coordinates)) errors.push(`Объект ${number}: все кольца зоны должны быть замкнутыми полигонами.`);
    }
    const route = ROUTE_TYPES.has(properties.change_type) && feature.geometry.type === 'LineString';
    for (const [coordinateIndex, point] of geometryCoordinates(feature.geometry).entries()) {
      if (!coordinate(point)) errors.push(`Объект ${number}, координата ${coordinateIndex + 1}: некорректные координаты WGS84.`);
      else if (!route && !containsPoint(point, boundary)) errors.push(`Объект ${number}, координата ${coordinateIndex + 1}: вне границы САО.`);
    }
    if (!route) {
      for (const [segmentIndex, [start, end]] of geometrySegments(feature.geometry).entries()) {
        if (!segmentWithinBoundary(start, end, edges)) errors.push(`Объект ${number}, сторона ${segmentIndex + 1}: пересекает границу САО.`);
      }
    }
    if (feature.geometry.type === 'Polygon' && polygonContainsBoundaryHole(feature.geometry, polygons)) errors.push(`Объект ${number}: зона пересекает исключённую область САО.`);
  }
  return { valid: errors.length === 0, errors };
}

export function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
