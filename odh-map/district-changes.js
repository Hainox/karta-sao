/* Common, browser-only GeoJSON contract for district proposals. */
(function () {
  'use strict';

  const VERSION = 'district_change_set_v2';
  const REVIEW_VERSION = 'district_review_bundle_v2';
  const DISTRICTS = [
    'Аэропорт', 'Беговой', 'Бескудниковский', 'Войковский', 'Восточное Дегунино',
    'Головинский', 'Дмитровский', 'Западное Дегунино', 'Коптево', 'Левобережный',
    'Молжаниновский', 'Савеловский', 'Сокол', 'Тимирязевский', 'Ховрино', 'Хорошевский'
  ];
  const TYPES = {
    queue: { label: 'Очередность уборки', geometry: 'LineString', kind: 'line' },
    rotor_transfer: { label: 'Роторная перекидка', geometry: 'LineString', kind: 'line' },
    rotor_snow_storage_zone: { label: 'Зона складирования роторного снега', geometry: 'Polygon', kind: 'polygon' },
    temporary_snow_storage: { label: 'Временное складирование снега', geometry: 'Point', kind: 'point' },
    dry_snow_dump: { label: 'Сухая свалка снега', geometry: 'Point', kind: 'point' },
    pgm: { label: 'Контейнеры ПГМ', geometry: 'Point', kind: 'point' },
    smm_storage: { label: 'Место хранения СММ', geometry: 'Point', kind: 'point' },
    other: { label: 'Другой объект', geometry: 'Point', kind: 'point' }
  };
  const ROUTE_TYPES = new Set(['queue', 'rotor_transfer']);

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function isCoordinate(value) { return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90; }
  function sameCoordinate(a, b) { return isCoordinate(a) && isCoordinate(b) && a[0] === b[0] && a[1] === b[1]; }
  function pointInRing(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [x, y] = ring[index]; const [previousX, previousY] = ring[previous];
      const intersects = ((y > point[1]) !== (previousY > point[1])) && point[0] < (previousX - x) * (point[1] - y) / (previousY - y) + x;
      if (intersects) inside = !inside;
    }
    return inside;
  }
  function pointInPolygon(point, coordinates) { return pointInRing(point, coordinates[0]) && !coordinates.slice(1).some((ring) => pointInRing(point, ring)); }
  function vertexInBoundary(point, boundary) {
    if (!isCoordinate(point) || !Array.isArray(boundary?.features)) return false;
    return boundary.features.some((feature) => {
      const geometry = feature?.geometry;
      if (!geometry) return false;
      if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
      if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
      return false;
    });
  }
  function coordinatesFor(geometry) {
    if (geometry?.type === 'Point') return [geometry.coordinates];
    if (geometry?.type === 'LineString') return geometry.coordinates || [];
    if (geometry?.type === 'Polygon') return (geometry.coordinates || []).flat();
    return [];
  }
  function upgradeChangeSet(value) {
    if (!value || value.change_set_version !== 'district_change_set_v1') return value;
    const upgraded = clone(value); upgraded.change_set_version = VERSION;
    upgraded.features = (upgraded.features || []).map((feature) => {
      const properties = feature.properties || (feature.properties = {});
      if (ROUTE_TYPES.has(properties.change_type) && feature.geometry?.type === 'LineString') {
        const coordinates = feature.geometry.coordinates || [];
        properties.route_start = properties.route_start || clone(coordinates[0]);
        properties.route_end = properties.route_end || clone(coordinates.at(-1));
        properties.route_direction = properties.route_direction || 'start_to_end';
        properties.nozzle_direction = properties.nozzle_direction || 'both';
      }
      return feature;
    });
    return upgraded;
  }
  function validateFeature(feature, index, boundary, errors, expected = {}) {
    const number = index + 1; const properties = feature?.properties; const type = properties && TYPES[properties.change_type];
    if (!feature || feature.type !== 'Feature' || !feature.geometry) { errors.push(`Объект ${number}: повреждённая GeoJSON-структура.`); return; }
    if (!type) errors.push(`Объект ${number}: неизвестный тип изменения.`);
    if (!type || feature.geometry.type !== type.geometry) errors.push(`Объект ${number}: для выбранного типа нужна геометрия ${type ? type.geometry : 'Point, LineString или Polygon'}.`);
    if (!DISTRICTS.includes(properties?.district)) errors.push(`Объект ${number}: укажите корректный район САО.`);
    if (typeof properties?.author !== 'string' || !properties.author.trim()) errors.push(`Объект ${number}: укажите исполнителя.`);
    if (expected.district && properties?.district !== expected.district) errors.push(`Объект ${number}: район должен совпадать с карточкой набора.`);
    if (expected.author && properties?.author !== expected.author) errors.push(`Объект ${number}: исполнитель должен совпадать с карточкой набора.`);
    if (typeof properties?.address !== 'string' || !properties.address.trim()) errors.push(`Объект ${number}: укажите адрес или ориентир.`);
    if (properties?.change_type === 'queue' && !['1', '2', '3'].includes(String(properties.queue_priority))) errors.push(`Объект ${number}: очередь должна быть 1, 2 или 3.`);
    const coordinates = coordinatesFor(feature.geometry);
    if (feature.geometry.type === 'LineString' && coordinates.length < 2) errors.push(`Объект ${number}: маршрут должен содержать минимум две вершины.`);
    if (feature.geometry.type === 'Polygon') {
      const ring = feature.geometry.coordinates?.[0] || [];
      if (ring.length < 4 || !sameCoordinate(ring[0], ring.at(-1))) errors.push(`Объект ${number}: зона должна быть замкнутым полигоном.`);
    }
    if (ROUTE_TYPES.has(properties?.change_type) && feature.geometry.type === 'LineString') {
      if (!sameCoordinate(properties.route_start, coordinates[0]) || !sameCoordinate(properties.route_end, coordinates.at(-1))) errors.push(`Объект ${number}: начало и конец маршрута должны быть явно заданы.`);
      if (properties.route_direction !== 'start_to_end') errors.push(`Объект ${number}: направление маршрута повреждено.`);
      if (!['left', 'right', 'both'].includes(properties.nozzle_direction)) errors.push(`Объект ${number}: направление сопла — left, right или both.`);
    }
    coordinates.forEach((point, coordinateIndex) => {
      if (!isCoordinate(point)) errors.push(`Объект ${number}, вершина ${coordinateIndex + 1}: некорректные координаты.`);
      else if (!vertexInBoundary(point, boundary)) errors.push(`Объект ${number}, вершина ${coordinateIndex + 1}: находится за границей САО.`);
    });
  }
  function validate(changeSet, boundary) {
    const errors = [];
    if (!changeSet || changeSet.type !== 'FeatureCollection') errors.push('Нужен GeoJSON типа FeatureCollection.');
    if (!changeSet || changeSet.change_set_version !== VERSION) errors.push(`Ожидается формат ${VERSION}.`);
    if (!DISTRICTS.includes(changeSet?.district)) errors.push('Выберите корректный район САО.');
    if (typeof changeSet?.author !== 'string' || !changeSet.author.trim()) errors.push('Укажите исполнителя.');
    if (!Array.isArray(changeSet?.features)) return { valid: false, errors };
    if (!changeSet.features.length) errors.push('Нужно добавить хотя бы один объект.');
    if (changeSet.features.length > 500) errors.push('В одном наборе может быть не более 500 объектов.');
    changeSet.features.forEach((feature, index) => validateFeature(feature, index, boundary, errors, { district: changeSet.district, author: changeSet.author }));
    return { valid: !errors.length, errors };
  }
  function validateReviewBundle(bundle, boundary) {
    const errors = [];
    if (!bundle || bundle.type !== 'FeatureCollection') errors.push('Нужен GeoJSON типа FeatureCollection.');
    if (!bundle || bundle.review_bundle_version !== REVIEW_VERSION) errors.push(`Ожидается сводка формата ${REVIEW_VERSION}.`);
    if (!Array.isArray(bundle?.sources) || !bundle.sources.length) errors.push('В сводке не указаны принятые файлы районов.');
    if (!Array.isArray(bundle?.features)) return { valid: false, errors };
    if (!bundle.features.length) errors.push('В сводке нет объектов.');
    if (bundle.features.length > 8000) errors.push('В сводке может быть не более 8000 объектов.');
    bundle.features.forEach((feature, index) => validateFeature(feature, index, boundary, errors));
    return { valid: !errors.length, errors };
  }
  function styleFor(feature) {
    const properties = feature.properties || {};
    if (properties.change_type === 'queue') return { color: ({ '1': '#ff4e64', '2': '#51a8ff', '3': '#46dca1' })[String(properties.queue_priority)] || '#bec8d8', dashArray: '12 8', weight: 5 };
    if (properties.change_type === 'rotor_transfer') return { color: '#b98cff', dashArray: '4 9', weight: 5 };
    if (properties.change_type === 'rotor_snow_storage_zone') return { color: '#34d6d0', weight: 3, fillOpacity: .22 };
    return { color: ({ temporary_snow_storage: '#26c6da', dry_snow_dump: '#b58a67', pgm: '#ffb34d', smm_storage: '#b98cff', other: '#8fa4b8' })[properties.change_type] || '#8fa4b8', weight: 3 };
  }
  function labelFor(type) { return TYPES[type]?.label || 'Неизвестный объект'; }
  function makeChangeSet(metadata, features) {
    return { type: 'FeatureCollection', change_set_version: VERSION, district: metadata.district, author: metadata.author.trim(), created_at: metadata.created_at || new Date().toISOString(), submission_status: 'draft', features: clone(features) };
  }
  window.DistrictChanges = { VERSION, REVIEW_VERSION, DISTRICTS, TYPES, ROUTE_TYPES, labelFor, makeChangeSet, styleFor, validate, validateReviewBundle, vertexInBoundary, upgradeChangeSet };
}());
