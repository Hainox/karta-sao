/* Browser-only exchange format for proposed district map changes. */
(function () {
  'use strict';

  const VERSION = 'district_change_set_v1';
  const DISTRICTS = [
    'Аэропорт', 'Беговой', 'Бескудниковский', 'Войковский', 'Восточное Дегунино',
    'Головинский', 'Дмитровский', 'Западное Дегунино', 'Коптево', 'Левобережный',
    'Молжаниновский', 'Савеловский', 'Сокол', 'Тимирязевский', 'Ховрино', 'Хорошевский'
  ];
  const TYPES = {
    queue: { label: 'Очередность уборки', geometry: 'LineString', kind: 'line' },
    rotor_transfer: { label: 'Роторная перекидка', geometry: 'LineString', kind: 'line' },
    temporary_snow_storage: { label: 'Временное складирование снега', geometry: 'Point', kind: 'point' },
    dry_snow_dump: { label: 'Сухая свалка снега', geometry: 'Point', kind: 'point' },
    pgm: { label: 'Контейнеры ПГМ', geometry: 'Point', kind: 'point' },
    smm_storage: { label: 'Место хранения СММ', geometry: 'Point', kind: 'point' },
    other: { label: 'Другой объект', geometry: 'Point', kind: 'point' }
  };

  function isCoordinate(value) {
    return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
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

  function pointInPolygon(point, coordinates) {
    return pointInRing(point, coordinates[0]) && !coordinates.slice(1).some(ring => pointInRing(point, ring));
  }

  function vertexInBoundary(point, boundary) {
    if (!isCoordinate(point) || !boundary || !Array.isArray(boundary.features)) return false;
    return boundary.features.some(feature => {
      const geometry = feature && feature.geometry;
      if (!geometry) return false;
      if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
      if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(polygon => pointInPolygon(point, polygon));
      return false;
    });
  }

  function coordinatesFor(geometry) {
    if (geometry && geometry.type === 'Point') return [geometry.coordinates];
    if (geometry && geometry.type === 'LineString') return geometry.coordinates;
    return [];
  }

  function validateFeature(feature, index, boundary, errors, expected = {}) {
    const number = index + 1;
    const properties = feature && feature.properties;
    const type = properties && TYPES[properties.change_type];
    if (!feature || feature.type !== 'Feature' || !feature.geometry) {
      errors.push(`Объект ${number}: повреждённая GeoJSON-структура.`);
      return;
    }
    if (!type) errors.push(`Объект ${number}: неизвестный тип изменения.`);
    if (!type || feature.geometry.type !== type.geometry) errors.push(`Объект ${number}: для выбранного типа нужна геометрия ${type ? type.geometry : 'Point или LineString'}.`);
    if (!properties || !DISTRICTS.includes(properties.district)) errors.push(`Объект ${number}: укажите корректный район САО.`);
    if (!properties || typeof properties.author !== 'string' || !properties.author.trim()) errors.push(`Объект ${number}: укажите исполнителя.`);
    if (expected.district && (!properties || properties.district !== expected.district)) errors.push(`Объект ${number}: район должен совпадать с карточкой набора.`);
    if (expected.author && (!properties || properties.author !== expected.author)) errors.push(`Объект ${number}: исполнитель должен совпадать с карточкой набора.`);
    if (!properties || typeof properties.address !== 'string' || !properties.address.trim()) errors.push(`Объект ${number}: укажите адрес или ориентир.`);
    if (properties && properties.change_type === 'queue' && !['1', '2', '3'].includes(String(properties.queue_priority))) errors.push(`Объект ${number}: очередь должна быть 1, 2 или 3.`);
    const coordinates = coordinatesFor(feature.geometry);
    if (feature.geometry.type === 'LineString' && coordinates.length < 2) errors.push(`Объект ${number}: линия должна содержать минимум две вершины.`);
    coordinates.forEach((point, coordinateIndex) => {
      if (!isCoordinate(point)) errors.push(`Объект ${number}, вершина ${coordinateIndex + 1}: некорректные координаты.`);
      else if (!vertexInBoundary(point, boundary)) errors.push(`Объект ${number}, вершина ${coordinateIndex + 1}: находится за границей САО.`);
    });
  }

  function validate(changeSet, boundary) {
    const errors = [];
    if (!changeSet || changeSet.type !== 'FeatureCollection') errors.push('Нужен GeoJSON типа FeatureCollection.');
    if (!changeSet || changeSet.change_set_version !== VERSION) errors.push(`Ожидается формат ${VERSION}.`);
    if (!changeSet || !DISTRICTS.includes(changeSet.district)) errors.push('Выберите корректный район САО.');
    if (!changeSet || typeof changeSet.author !== 'string' || !changeSet.author.trim()) errors.push('Укажите исполнителя.');
    if (!changeSet || !Array.isArray(changeSet.features)) return { valid: false, errors };
    if (changeSet.features.length === 0) errors.push('Нужно добавить хотя бы один объект.');
    if (changeSet.features.length > 500) errors.push('В одном наборе может быть не более 500 объектов.');
    changeSet.features.forEach((feature, index) => validateFeature(feature, index, boundary, errors, { district: changeSet.district, author: changeSet.author }));
    return { valid: errors.length === 0, errors };
  }

  function validateReviewBundle(bundle, boundary) {
    const errors = [];
    if (!bundle || bundle.type !== 'FeatureCollection') errors.push('Нужен GeoJSON типа FeatureCollection.');
    if (!bundle || bundle.review_bundle_version !== 'district_review_bundle_v1') errors.push('Ожидается сводка формата district_review_bundle_v1.');
    if (!bundle || !Array.isArray(bundle.sources) || bundle.sources.length === 0) errors.push('В сводке не указаны принятые файлы районов.');
    if (!bundle || !Array.isArray(bundle.features)) return { valid: false, errors };
    if (bundle.features.length === 0) errors.push('В сводке нет объектов.');
    if (bundle.features.length > 8000) errors.push('В сводке может быть не более 8000 объектов.');
    bundle.features.forEach((feature, index) => validateFeature(feature, index, boundary, errors));
    return { valid: errors.length === 0, errors };
  }

  function styleFor(feature) {
    const properties = feature.properties || {};
    if (properties.change_type === 'queue') {
      return { color: ({ '1': '#ff0000', '2': '#0000ff', '3': '#00b050' })[String(properties.queue_priority)] || '#555', dashArray: '10 6', weight: 5 };
    }
    if (properties.change_type === 'rotor_transfer') return { color: '#7030a0', dashArray: '4 8', weight: 5 };
    return { color: ({ temporary_snow_storage: '#00acc1', dry_snow_dump: '#6d4c41', pgm: '#ef6c00', smm_storage: '#6a1b9a', other: '#455a64' })[properties.change_type] || '#455a64', weight: 3 };
  }

  function labelFor(type) {
    return TYPES[type] ? TYPES[type].label : 'Неизвестный объект';
  }

  function makeChangeSet(metadata, features) {
    return {
      type: 'FeatureCollection',
      change_set_version: VERSION,
      district: metadata.district,
      author: metadata.author.trim(),
      created_at: metadata.created_at || new Date().toISOString(),
      submission_status: 'draft',
      features: features.map(feature => JSON.parse(JSON.stringify(feature)))
    };
  }

  window.DistrictChanges = { VERSION, DISTRICTS, TYPES, labelFor, makeChangeSet, styleFor, validate, validateReviewBundle, vertexInBoundary };
}());
