/* Common, browser-only GeoJSON contract for district proposals. */
(function () {
  'use strict';

  const VERSION = 'district_change_set_v2';
  const REVIEW_VERSION = 'district_review_bundle_v2';
  const DISTRICTS = [
    'Аэропорт', 'Беговой', 'Бескудниковский', 'Войковский', 'Восточное Дегунино',
    'Головинский', 'Дмитровский', 'Западное Дегунино', 'Коптево', 'Левобережный',
    'Молжаниновский', 'Савеловский', 'Сокол', 'Тимирязевский', 'Ховрино', 'Хорошевский',
    // АвД САО рисует маршруты наравне с районами — своя строка и в приёмке, и в выгрузках.
    'АвД САО'
  ];
  // Единый словарь типов. Отсюда выводятся цвет, штрих, короткий код, категория
  // и назначение — легенда, подписи на карте и карточка объекта на обеих сторонах
  // (район и префектура) строятся из одного источника, а не из трёх копий.
  const TYPES = {
    queue: {
      label: 'Очередность уборки', geometry: 'LineString', kind: 'line', group: 'route',
      short: 'ОЧ', shortByPriority: { '1': 'ОЧ-I', '2': 'ОЧ-II', '3': 'ОЧ-III' },
      priorityNames: { '1': 'I очередь', '2': 'II очередь', '3': 'III очередь' },
      color: '#bec8d8', colors: { '1': '#ff4e64', '2': '#51a8ff', '3': '#46dca1' }, weight: 5,
      purpose: 'В какой очереди убирают эту улицу'
    },
    rotor_transfer: {
      label: 'Роторная перекидка', geometry: 'LineString', kind: 'line', group: 'route',
      short: 'РП', color: '#b98cff', dashArray: '4 9', weight: 5,
      purpose: 'Куда ротор перебрасывает снег'
    },
    dkm_route: {
      label: 'Маршрут ДКМ — ОДХ', geometry: 'LineString', kind: 'line', group: 'route',
      short: 'ДКМ', color: '#ff7a45', weight: 5,
      purpose: 'Проезд дорожной коммунальной машины по дорогам'
    },
    tu_route: {
      label: 'Маршрут ТУ — ОДХ', geometry: 'LineString', kind: 'line', group: 'route',
      short: 'ТУ', color: '#2ec4b6', weight: 5,
      purpose: 'Проезд трактора-щётки по дорогам'
    },
    tu_route_yards: {
      label: 'Маршрут ТУ — дворы', geometry: 'LineString', kind: 'line', group: 'route',
      short: 'ТУ-дв', color: '#2ec4b6', dashArray: '7 6', weight: 5,
      purpose: 'Проезд трактора-щётки внутри дворов'
    },
    rotor_snow_storage_zone: {
      label: 'Зона складирования роторного снега', geometry: 'Polygon', kind: 'polygon', group: 'zone',
      short: 'Зона', color: '#34d6d0', weight: 3, fillOpacity: .22,
      purpose: 'Площадка, куда складывают снег ротором'
    },
    temporary_snow_storage: {
      label: 'Временное складирование снега', geometry: 'Point', kind: 'point', group: 'point',
      short: 'Снег', color: '#26c6da', weight: 3,
      purpose: 'Точка временного складирования снега'
    },
    dry_snow_dump: {
      label: 'Сухая свалка снега', geometry: 'Point', kind: 'point', group: 'point',
      short: 'Свалка', color: '#b58a67', weight: 3,
      purpose: 'Место вывоза и складирования сухого снега'
    },
    pgm: {
      label: 'Контейнеры ПГМ', geometry: 'Point', kind: 'point', group: 'point',
      short: 'ПГМ', color: '#ffb34d', weight: 3,
      purpose: 'Контейнерная площадка ПГМ'
    },
    smm_storage: {
      label: 'Место хранения СММ', geometry: 'Point', kind: 'point', group: 'point',
      short: 'СММ', color: '#b98cff', weight: 3,
      purpose: 'Где хранится средства малой механизации'
    },
    other: {
      label: 'Другой объект', geometry: 'Point', kind: 'point', group: 'point',
      short: 'Объект', color: '#8fa4b8', weight: 3,
      purpose: 'Другой объект разметки'
    }
  };
  const ROUTE_TYPES = new Set(['queue', 'rotor_transfer', 'dkm_route', 'tu_route', 'tu_route_yards']);
  const GROUP_LABELS = { route: 'Маршруты', zone: 'Зоны', point: 'Точки' };
  const ROMAN = { '1': 'I', '2': 'II', '3': 'III' };
  const SEGMENT_EPSILON = 1e-12;

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function isCoordinate(value) { return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90; }
  function sameCoordinate(a, b) { return isCoordinate(a) && isCoordinate(b) && a[0] === b[0] && a[1] === b[1]; }
  function routeDuplicateKey(feature) {
    const properties = feature?.properties || {};
    if (!ROUTE_TYPES.has(properties.change_type) || feature?.geometry?.type !== 'LineString' || !Array.isArray(feature.geometry.coordinates)) return null;
    const coordinates = feature.geometry.coordinates;
    const forward = JSON.stringify(coordinates);
    const reverse = JSON.stringify([...coordinates].reverse());
    const routeClass = `${properties.change_type}:${properties.change_type === 'queue' ? properties.queue_priority : ''}`;
    return `${routeClass}:${forward < reverse ? forward : reverse}`;
  }
  function pointInRing(point, ring) {
    if (!isCoordinate(point) || !Array.isArray(ring) || ring.length < 3) return false;
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [x, y] = ring[index]; const [previousX, previousY] = ring[previous];
      const intersects = ((y > point[1]) !== (previousY > point[1])) && point[0] < (previousX - x) * (point[1] - y) / (previousY - y) + x;
      if (intersects) inside = !inside;
    }
    return inside;
  }
  function pointInPolygon(point, coordinates) { return pointInRing(point, coordinates[0]) && !coordinates.slice(1).some((ring) => pointInRing(point, ring)); }
  function polygonCoordinates(geometry) {
    if (geometry?.type === 'Polygon') return [geometry.coordinates];
    if (geometry?.type === 'MultiPolygon') return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    return [];
  }
  function boundaryPolygons(boundary) {
    const features = Array.isArray(boundary?.features) ? boundary.features : [];
    const saoBoundary = features.find((feature) => feature?.properties?.feature_kind === 'boundary_sao');
    return (saoBoundary ? [saoBoundary] : features).flatMap((feature) => polygonCoordinates(feature?.geometry));
  }
  function boundarySegments(polygons) {
    const segments = [];
    for (const polygon of polygons) for (const ring of polygon || []) {
      if (!Array.isArray(ring)) continue;
      for (let index = 1; index < ring.length; index++) {
        const start = ring[index - 1]; const end = ring[index];
        if (!isCoordinate(start) || !isCoordinate(end)) continue;
        segments.push({ start, end, minX:Math.min(start[0], end[0]), maxX:Math.max(start[0], end[0]), minY:Math.min(start[1], end[1]), maxY:Math.max(start[1], end[1]) });
      }
    }
    return segments;
  }
  function orientation(first, second, third) { return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]); }
  function onSegment(first, second, point) {
    return Math.abs(orientation(first, second, point)) <= SEGMENT_EPSILON &&
      point[0] >= Math.min(first[0], second[0]) - SEGMENT_EPSILON && point[0] <= Math.max(first[0], second[0]) + SEGMENT_EPSILON &&
      point[1] >= Math.min(first[1], second[1]) - SEGMENT_EPSILON && point[1] <= Math.max(first[1], second[1]) + SEGMENT_EPSILON;
  }
  function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
    const first = orientation(firstStart, firstEnd, secondStart); const second = orientation(firstStart, firstEnd, secondEnd);
    const third = orientation(secondStart, secondEnd, firstStart); const fourth = orientation(secondStart, secondEnd, firstEnd);
    if ((first > SEGMENT_EPSILON && second < -SEGMENT_EPSILON || first < -SEGMENT_EPSILON && second > SEGMENT_EPSILON) &&
      (third > SEGMENT_EPSILON && fourth < -SEGMENT_EPSILON || third < -SEGMENT_EPSILON && fourth > SEGMENT_EPSILON)) return true;
    return Math.abs(first) <= SEGMENT_EPSILON && onSegment(firstStart, firstEnd, secondStart) ||
      Math.abs(second) <= SEGMENT_EPSILON && onSegment(firstStart, firstEnd, secondEnd) ||
      Math.abs(third) <= SEGMENT_EPSILON && onSegment(secondStart, secondEnd, firstStart) ||
      Math.abs(fourth) <= SEGMENT_EPSILON && onSegment(secondStart, secondEnd, firstEnd);
  }
  function segmentWithinBoundary(start, end, segments) {
    if (!isCoordinate(start) || !isCoordinate(end)) return false;
    for (const boundarySegment of segments) {
      if (Math.max(start[0], end[0]) < boundarySegment.minX - SEGMENT_EPSILON || Math.min(start[0], end[0]) > boundarySegment.maxX + SEGMENT_EPSILON ||
        Math.max(start[1], end[1]) < boundarySegment.minY - SEGMENT_EPSILON || Math.min(start[1], end[1]) > boundarySegment.maxY + SEGMENT_EPSILON) continue;
      if (segmentsIntersect(start, end, boundarySegment.start, boundarySegment.end)) return false;
    }
    return true;
  }
  function pointWithinBoundary(point, polygons) { return isCoordinate(point) && polygons.some((polygon) => pointInPolygon(point, polygon)); }
  function vertexInBoundary(point, boundary) {
    return Array.isArray(boundary?.features) && pointWithinBoundary(point, boundaryPolygons(boundary));
  }
  function coordinatesFor(geometry) {
    if (geometry?.type === 'Point') return [geometry.coordinates];
    if (geometry?.type === 'LineString') return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    if (geometry?.type === 'Polygon') return Array.isArray(geometry.coordinates) ? geometry.coordinates.flatMap((ring) => Array.isArray(ring) ? ring : [ring]) : [];
    return [];
  }
  function geometrySegments(geometry) {
    const rings = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'Polygon' ? geometry.coordinates : [];
    return (Array.isArray(rings) ? rings : []).flatMap((ring) => Array.isArray(ring) ? ring.slice(1).map((end, index) => [ring[index], end]) : []);
  }
  function ringsAreClosedAndValid(rings) {
    return Array.isArray(rings) && rings.length > 0 && rings.every((ring) => Array.isArray(ring) && ring.length >= 4 && sameCoordinate(ring[0], ring.at(-1)));
  }
  function polygonContainsBoundaryHole(geometry, polygons) {
    return polygons.some((polygon) => (polygon || []).slice(1).some((ring) => Array.isArray(ring) && ring.length && pointInPolygon(ring[0], geometry.coordinates)));
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
  /**
   * Имя объекта в сообщении об ошибке. В наборах с номерами (новые черновики)
   * показываем номер, тип и адрес — по ним объект находят на карте. Для старых
   * наборов без номеров остаётся порядковый номер в файле.
   */
  function objectLabel(feature, index) {
    const number = numberOf(feature, index);
    const properties = feature?.properties || {};
    if (!Number.isSafeInteger(properties.object_no) || properties.object_no < 1) return `Объект ${number}`;
    const type = TYPES[properties.change_type];
    const parts = [];
    if (type) parts.push(type.label);
    const priority = type?.priorityNames?.[String(properties.queue_priority)];
    if (priority) parts.push(priority);
    const address = typeof properties.address === 'string' ? properties.address.trim() : '';
    if (address) parts.push(address);
    return parts.length ? `Объект ${number} (${parts.join(' · ')})` : `Объект ${number}`;
  }
  function validateFeature(feature, index, boundary, errors, expected = {}, polygons = boundaryPolygons(boundary), edges = boundarySegments(polygons)) {
    const properties = feature?.properties; const type = properties && TYPES[properties.change_type]; const label = objectLabel(feature, index);
    if (!feature || feature.type !== 'Feature' || !feature.geometry) { errors.push(`${label}: повреждённая GeoJSON-структура.`); return; }
    // Тип могли убрать из словаря после того, как объект нарисовали: говорим об этом
    // прямо, иначе район видит только «неизвестный тип» и не понимает, что делать.
    if (!type) errors.push(`${label}: тип «${properties?.change_type ?? 'не указан'}» больше не поддерживается. Удалите объект и нарисуйте его заново.`);
    else if (feature.geometry.type !== type.geometry) errors.push(`${label}: для выбранного типа нужна геометрия ${type.geometry}.`);
    if (!DISTRICTS.includes(properties?.district)) errors.push(`${label}: укажите корректный район САО.`);
    if (typeof properties?.author !== 'string' || !properties.author.trim()) errors.push(`${label}: укажите исполнителя.`);
    if (expected.district && properties?.district !== expected.district) errors.push(`${label}: район должен совпадать с карточкой набора.`);
    if (expected.author && properties?.author !== expected.author) errors.push(`${label}: исполнитель должен совпадать с карточкой набора.`);
    if (typeof properties?.address !== 'string' || !properties.address.trim()) errors.push(`${label}: укажите адрес или ориентир.`);
    if (properties?.change_type === 'queue' && !['1', '2', '3'].includes(String(properties.queue_priority))) errors.push(`${label}: очередь должна быть 1, 2 или 3.`);
    const coordinates = coordinatesFor(feature.geometry);
    if (feature.geometry.type === 'LineString' && coordinates.length < 2) errors.push(`${label}: маршрут должен содержать минимум две вершины.`);
    if (feature.geometry.type === 'Polygon' && !ringsAreClosedAndValid(feature.geometry.coordinates)) errors.push(`${label}: все кольца зоны должны быть замкнутыми полигонами.`);
    if (ROUTE_TYPES.has(properties?.change_type) && feature.geometry.type === 'LineString') {
      if (!sameCoordinate(properties.route_start, coordinates[0]) || !sameCoordinate(properties.route_end, coordinates.at(-1))) errors.push(`${label}: начало и конец маршрута должны быть явно заданы.`);
      if (properties.route_direction !== 'start_to_end') errors.push(`${label}: направление маршрута повреждено.`);
      if (!['left', 'right', 'both'].includes(properties.nozzle_direction)) errors.push(`${label}: направление сопла — left, right или both.`);
    }
    const route = ROUTE_TYPES.has(properties?.change_type) && feature.geometry.type === 'LineString';
    coordinates.forEach((point, coordinateIndex) => {
      if (!isCoordinate(point)) errors.push(`${label}, вершина ${coordinateIndex + 1}: некорректные координаты.`);
      else if (!route && !pointWithinBoundary(point, polygons)) errors.push(`${label}, вершина ${coordinateIndex + 1}: находится за границей САО.`);
    });
    if (!route) geometrySegments(feature.geometry).forEach(([start, end], segmentIndex) => {
      if (!segmentWithinBoundary(start, end, edges)) errors.push(`${label}, сторона ${segmentIndex + 1}: пересекает границу САО.`);
    });
    if (feature.geometry.type === 'Polygon' && polygonContainsBoundaryHole(feature.geometry, polygons)) errors.push(`${label}: зона пересекает исключённую область САО.`);
  }
  function validate(changeSet, boundary) {
    const errors = [];
    if (!changeSet || changeSet.type !== 'FeatureCollection') errors.push('Нужен GeoJSON типа FeatureCollection.');
    if (!changeSet || changeSet.change_set_version !== VERSION) errors.push(`Ожидается формат ${VERSION}.`);
    if (!DISTRICTS.includes(changeSet?.district)) errors.push('Выберите корректный район САО.');
    if (typeof changeSet?.author !== 'string' || !changeSet.author.trim()) errors.push('Укажите исполнителя.');
    if (!Array.isArray(changeSet?.features)) return { valid: false, errors };
    if (!changeSet.features.length) errors.push('Нужно добавить хотя бы один объект.');
    const routes = new Map();
    changeSet.features.forEach((feature, index) => {
      const key = routeDuplicateKey(feature);
      if (key === null) return;
      if (routes.has(key)) errors.push(`Маршрут ${index + 1} дублирует маршрут ${routes.get(key)} в этом наборе; удалите повтор.`);
      else routes.set(key, index + 1);
    });
    const polygons = boundaryPolygons(boundary); const edges = boundarySegments(polygons);
    changeSet.features.forEach((feature, index) => validateFeature(feature, index, boundary, errors, { district: changeSet.district, author: changeSet.author }, polygons, edges));
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
    const polygons = boundaryPolygons(boundary); const edges = boundarySegments(polygons);
    bundle.features.forEach((feature, index) => validateFeature(feature, index, boundary, errors, {}, polygons, edges));
    return { valid: !errors.length, errors };
  }
  // Стиль выводится из словаря типов, а не из второй копии цветов.
  function styleFor(feature) {
    const properties = feature?.properties || {};
    const type = TYPES[properties.change_type];
    if (!type) return { color: '#8fa4b8', weight: 3 };
    const color = type.colors ? (type.colors[String(properties.queue_priority)] || type.color) : type.color;
    const style = { color, weight: type.weight };
    if (type.dashArray) style.dashArray = type.dashArray;
    if (type.fillOpacity !== undefined) style.fillOpacity = type.fillOpacity;
    return style;
  }
  function labelFor(type) { return TYPES[type]?.label || 'Неизвестный объект'; }
  function typeOf(feature) { return TYPES[feature?.properties?.change_type] || null; }
  function groupOf(feature) { return typeOf(feature)?.group || 'point'; }

  // Номер объекта внутри набора. Присваивается один раз при создании и больше не
  // пересчитывается, чтобы ссылка «№7» не съезжала после удаления соседа.
  function numberOf(feature, index) {
    const value = feature?.properties?.object_no;
    if (Number.isSafeInteger(value) && value > 0) return value;
    return Number.isSafeInteger(index) && index >= 0 ? index + 1 : null;
  }
  function nextObjectNo(features) {
    let highest = 0;
    for (const feature of features || []) {
      const value = feature?.properties?.object_no;
      if (Number.isSafeInteger(value) && value > highest) highest = value;
    }
    return highest + 1;
  }
  function assignObjectNo(feature, features) {
    if (!feature || !feature.properties) return null;
    if (!Number.isSafeInteger(feature.properties.object_no) || feature.properties.object_no < 1) {
      feature.properties.object_no = nextObjectNo(features);
    }
    return feature.properties.object_no;
  }

  /** Короткий код объекта: «ОЧ-II», «РП», «ТУ-дв», «Зона». */
  function shortFor(feature) {
    const properties = feature?.properties || {};
    const type = TYPES[properties.change_type];
    if (!type) return 'Объект';
    return type.shortByPriority?.[String(properties.queue_priority)] || type.short;
  }

  /** Бейдж для карты и списков: «ОЧ-II №3». */
  function badgeFor(feature, index) {
    const code = shortFor(feature);
    const number = numberOf(feature, index);
    return number === null ? code : `${code} №${number}`;
  }

  /** Очеловеченная строка: тип, очередь и адрес. */
  function describeFor(feature) {
    const properties = feature?.properties || {};
    const type = TYPES[properties.change_type];
    if (!type) return 'Неизвестный объект';
    const priority = type.priorityNames?.[String(properties.queue_priority)];
    const suffix = priority ? ` · ${priority}` : '';
    const address = typeof properties.address === 'string' && properties.address.trim() ? ` · ${properties.address.trim()}` : '';
    return `${type.label}${suffix}${address}`;
  }

  /** Направление и сопло — только для маршрутов; для остальных null. */
  function routeFactsFor(feature) {
    const properties = feature?.properties || {};
    if (!ROUTE_TYPES.has(properties.change_type)) return null;
    const nozzle = { left: 'влево по ходу', right: 'вправо по ходу', both: 'в обе стороны' }[properties.nozzle_direction] || 'не указано';
    return { nozzle, direction: 'от «НАЧАЛО» к «КОНЕЦ»' };
  }

  /** Разбивка набора по категориям: { route: 12, zone: 2, point: 5 }. */
  function groupCounts(features) {
    const counts = { route: 0, zone: 0, point: 0 };
    for (const feature of features || []) counts[groupOf(feature)] += 1;
    return counts;
  }
  function makeChangeSet(metadata, features) {
    return { type: 'FeatureCollection', change_set_version: VERSION, district: metadata.district, author: metadata.author.trim(), created_at: metadata.created_at || new Date().toISOString(), submission_status: 'draft', features: clone(features) };
  }
  window.DistrictChanges = {
    VERSION, REVIEW_VERSION, DISTRICTS, TYPES, ROUTE_TYPES, GROUP_LABELS, ROMAN,
    labelFor, typeOf, groupOf, shortFor, badgeFor, describeFor, routeFactsFor, groupCounts,
    numberOf, nextObjectNo, assignObjectNo,
    makeChangeSet, styleFor, validate, validateReviewBundle, vertexInBoundary, upgradeChangeSet
  };
}());
