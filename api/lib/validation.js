import crypto from 'node:crypto';

export const DISTRICTS = new Set([
  'Аэропорт', 'Беговой', 'Бескудниковский', 'Войковский', 'Восточное Дегунино',
  'Головинский', 'Дмитровский', 'Западное Дегунино', 'Коптево', 'Левобережный',
  'Молжаниновский', 'Савеловский', 'Сокол', 'Тимирязевский', 'Ховрино', 'Хорошевский'
]);

export const TYPES = {
  queue: 'LineString',
  rotor_transfer: 'LineString',
  temporary_snow_storage: 'Point',
  rotor_snow_storage_zone: 'Polygon',
  dry_snow_dump: 'Point',
  pgm: 'Point',
  smm_storage: 'Point',
  other: 'Point'
};

const ROUTE_TYPES = new Set(['queue', 'rotor_transfer']);

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

function containsPoint(point, boundary) {
  if (!coordinate(point) || !boundary?.features) return false;
  return boundary.features.some(({ geometry }) => {
    if (!geometry) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polygons.some((polygon) => pointInRing(point, polygon[0]) && !polygon.slice(1).some((ring) => pointInRing(point, ring)));
  });
}

export function isPointWithinBoundary(point, boundary) {
  return containsPoint(point, boundary);
}

function geometryCoordinates(geometry) {
  if (geometry?.type === 'Point') return [geometry.coordinates];
  if (geometry?.type === 'LineString') return geometry.coordinates || [];
  if (geometry?.type === 'Polygon') return (geometry.coordinates || []).flat();
  return [];
}

export function validateChangeSet(changeSet, boundary) {
  const errors = [];
  if (!changeSet || changeSet.type !== 'FeatureCollection') errors.push('Нужен GeoJSON типа FeatureCollection.');
  if (changeSet?.change_set_version !== 'district_change_set_v2') errors.push('Ожидается формат district_change_set_v2.');
  if (!DISTRICTS.has(changeSet?.district)) errors.push('Укажите корректный район САО.');
  if (typeof changeSet?.author !== 'string' || !changeSet.author.trim()) errors.push('Укажите исполнителя.');
  if (!Array.isArray(changeSet?.features) || !changeSet.features.length) errors.push('Нужно добавить хотя бы один объект.');
  if (changeSet?.features?.length > 500) errors.push('В одном наборе не более 500 объектов.');

  for (const [index, feature] of (changeSet?.features || []).entries()) {
    const number = index + 1;
    const properties = feature?.properties || {};
    const expectedGeometry = TYPES[properties.change_type];
    if (!feature || feature.type !== 'Feature' || !feature.geometry) { errors.push(`Объект ${number}: повреждён.`); continue; }
    if (!expectedGeometry || feature.geometry.type !== expectedGeometry) errors.push(`Объект ${number}: неверная геометрия для выбранного типа.`);
    if (properties.district !== changeSet.district || properties.author !== changeSet.author) errors.push(`Объект ${number}: карточка объекта не совпадает с набором.`);
    if (typeof properties.address !== 'string' || !properties.address.trim()) errors.push(`Объект ${number}: укажите адрес или ориентир.`);
    if (properties.change_type === 'queue' && !['1', '2', '3'].includes(String(properties.queue_priority))) errors.push(`Объект ${number}: очередь должна быть 1, 2 или 3.`);
    if (ROUTE_TYPES.has(properties.change_type) && feature.geometry.type === 'LineString') {
      const points = feature.geometry.coordinates || [];
      if (!sameCoordinate(properties.route_start, points[0]) || !sameCoordinate(properties.route_end, points.at(-1))) errors.push(`Объект ${number}: начало и конец маршрута должны быть явно заданы.`);
      if (properties.route_direction !== 'start_to_end') errors.push(`Объект ${number}: направление маршрута повреждено.`);
      if (!['left', 'right', 'both'].includes(properties.nozzle_direction)) errors.push(`Объект ${number}: направление сопла — left, right или both.`);
    }
    if (feature.geometry.type === 'LineString' && feature.geometry.coordinates.length < 2) errors.push(`Объект ${number}: маршрут должен содержать минимум две точки.`);
    if (feature.geometry.type === 'Polygon') {
      const ring = feature.geometry.coordinates?.[0] || [];
      if (ring.length < 4 || JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) errors.push(`Объект ${number}: зона должна быть замкнутым полигоном.`);
    }
    for (const [coordinateIndex, point] of geometryCoordinates(feature.geometry).entries()) {
      if (!coordinate(point) || !containsPoint(point, boundary)) errors.push(`Объект ${number}, координата ${coordinateIndex + 1}: вне границы САО.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
