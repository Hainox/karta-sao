/**
 * Определение района по точке: полигоны `districts.geojson` в WGS84, порядок
 * координат GeoJSON — [долгота, широта]. Границы взяты из OSM-контуров
 * муниципальных образований, поэтому пограничные точки могут попадать не в свой
 * район — это известное ограничение источника, а не ошибка расчёта.
 */
export function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Район точки или null, если точка вне всех полигонов (в том числе в воде). */
export function districtForPoint(latitude, longitude, features) {
  const point = [longitude, latitude];
  for (const feature of features) {
    if (!feature?.geometry) continue;
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      if (pointInRing(point, polygon[0]) && polygon.slice(1).every((hole) => !pointInRing(point, hole))) {
        return feature.properties.district;
      }
    }
  }
  return null;
}

/** Замыкает район по точке в функцию-обработчик для группировки объектов. */
export function districtResolver(features) {
  return (record) => districtForPoint(record.lat, record.lon, features);
}
