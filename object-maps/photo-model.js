// Pure helpers for the photo atlas client. No DOM and no network here so the
// mapping between the dataset records and the photo service can be unit tested.

// Норма фото на точку по видам объектов. Совпадает с серверной PHOTO_REQUIREMENTS
// (photo-service/src/completion.js). У пешеходного перехода снимают оба направления,
// поэтому на точку нужно два кадра; у остановки и подъезда — один.
// У объекта с одним ID точек может быть несколько, и каждая закрывается сама.
export const PHOTO_REQUIREMENTS = Object.freeze({ stop: 1, pp: 2, entrance: 1 });

export function photoRequirementFor(objectType) {
  return PHOTO_REQUIREMENTS[objectType] ?? 1;
}

const REVIEW_TEXT = Object.freeze({
  pending_review: 'На проверке',
  confirmed: 'Подтверждено',
  rejected: 'Отклонено',
  withdrawn: 'Отозвано районом',
});

const GEO_TEXT = Object.freeze({
  within_radius: 'В радиусе 15 м',
  within_tolerance: 'В допуске 15–30 м',
  risk: 'Нужна ручная проверка',
  review: 'Нужна ручная проверка',
});

const BAND_TEXT = Object.freeze({
  low: 'Красный',
  middle: 'Жёлтый',
  high: 'Зелёный',
});

const BAND_NOTE = Object.freeze({
  low: 'выполнение ниже 33 %',
  middle: 'выполнение от 33 % до 66 %',
  high: 'выполнение 66 % и выше',
});

const STATUS_TEXT = Object.freeze({
  done: 'Выполнено',
  partial: 'Частично',
  pending: 'На проверке',
  empty: 'Без фото',
});

function pick(row, snake, camel) {
  if (row[snake] !== undefined && row[snake] !== null) return row[snake];
  return row[camel] ?? null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// `GET /photos` returns raw database columns (snake_case) while `/reports/summary`
// returns camelCase objects. Both shapes are accepted so a client can never silently
// render "Invalid Date" or drop the GPS accuracy because of a field-name mismatch.
export function normalizePhoto(row) {
  if (!row || typeof row !== 'object') throw new TypeError('photo row must be an object');
  return {
    id: row.id,
    capturedAt: pick(row, 'captured_at', 'capturedAt'),
    uploadedAt: pick(row, 'uploaded_at', 'uploadedAt'),
    performer: pick(row, 'performer', 'performer') || '',
    comment: pick(row, 'comment', 'comment') || '',
    originalFilename: pick(row, 'original_filename', 'originalFilename') || 'photo.jpg',
    mimeType: pick(row, 'mime_type', 'mimeType') || '',
    byteSize: numberOrNull(pick(row, 'byte_size', 'byteSize')),
    gpsLatitude: numberOrNull(pick(row, 'gps_latitude', 'gpsLatitude')),
    gpsLongitude: numberOrNull(pick(row, 'gps_longitude', 'gpsLongitude')),
    gpsAccuracyM: numberOrNull(pick(row, 'gps_accuracy_m', 'gpsAccuracyM')),
    distanceM: numberOrNull(pick(row, 'distance_m', 'distanceM')),
    geoStatus: pick(row, 'geo_status', 'geoStatus') || '',
    reviewStatus: pick(row, 'review_status', 'reviewStatus') || '',
    reviewReason: pick(row, 'review_reason', 'reviewReason') || '',
    isReference: pick(row, 'is_reference', 'isReference') === true,
    storageKey: pick(row, 'storage_key', 'storageKey') || '',
  };
}

export function reviewStatusText(status) {
  return REVIEW_TEXT[status] || 'Статус не указан';
}

export function geoStatusText(status) {
  return GEO_TEXT[status] || 'Проверка не выполнялась';
}

export function bandText(band) {
  return BAND_TEXT[band] || 'Нет данных';
}

export function bandNote(band) {
  return BAND_NOTE[band] || 'Недостаточно данных для оценки';
}

export function statusText(statusKey) {
  return STATUS_TEXT[statusKey] || statusKey;
}

export function formatMeters(value) {
  const meters = numberOrNull(value);
  if (meters === null) return '—';
  return `${meters.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м`;
}

export function formatAccuracy(value) {
  const meters = numberOrNull(value);
  if (meters === null) return 'точность не сообщена';
  return `точность около ${Math.round(meters)} м`;
}

/**
 * Точность, после которой позиция не считается спутниковой. Браузер без доступа
 * к спутникам отдаёт точку по сети: одна координата на весь город и точность в
 * сотни километров. Такую фиксацию принимает сервис, но подтвердить место она
 * не может, поэтому клиент её не отправляет.
 *
 * Порог совпадает с серверным (UNUSABLE_ACCURACY_METERS в photo-service/src/geo.js).
 */
export const UNUSABLE_ACCURACY_METERS = 500;

/**
 * Порог, после которого фиксация уходит на ручную проверку. Он же на сервере
 * (`ACCURACY_REVIEW_METERS` в photo-service/src/geo.js) — совпадение проверяется
 * тестом, потому что от него зависит, что район увидит перед отправкой.
 */
export const ACCURACY_REVIEW_METERS = 5;

export function accuracyVerdict(accuracyMeters) {
  const meters = numberOrNull(accuracyMeters);
  // Отрицательная точность — мусор из браузера, а не «хороший замер».
  if (meters === null || meters < 0) return 'unknown';
  if (meters > UNUSABLE_ACCURACY_METERS) return 'unusable';
  return meters > ACCURACY_REVIEW_METERS ? 'review' : 'ok';
}

export function formatDateTime(value) {
  if (!value) return 'время не указано';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'время не указано';
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

// Координата без значения — это текст «GPS отсутствует», а не «Invalid Date» и не
// падение на undefined: строка набора приходит из таблицы, и её поля могут быть
// пустыми или заданы текстом.
export function formatCoordinates(latitude, longitude) {
  const lat = numberOrNull(latitude);
  const lon = numberOrNull(longitude);
  if (lat === null || lon === null) return 'GPS отсутствует';
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}


// One row per displayed property so the caption is asserted in tests instead of guessed.
export function photoDetailRows(photo) {
  const normalized = normalizePhoto(photo);
  return [
    { key: 'Снято', value: formatDateTime(normalized.capturedAt) },
    { key: 'Отправлено', value: formatDateTime(normalized.uploadedAt) },
    { key: 'Исполнитель', value: normalized.performer || 'не указан' },
    { key: 'Проверка', value: reviewStatusText(normalized.reviewStatus) },
    { key: 'GPS', value: formatCoordinates(normalized.gpsLatitude, normalized.gpsLongitude) },
    { key: 'Точность GPS', value: formatAccuracy(normalized.gpsAccuracyM) },
    { key: 'Геопроверка', value: geoStatusText(normalized.geoStatus) },
    { key: 'Дистанция до точки', value: formatMeters(normalized.distanceM) },
    { key: 'Комментарий', value: normalized.comment || '—' },
    { key: 'Эталонное фото', value: normalized.isReference ? 'Да' : 'Нет' },
  ];
}

/**
 * Index the report payload by every source id. Photos are counted per point:
 * a snapshot taken at one coordinate row of a multi-point object must not look
 * like a snapshot of its neighbours, even though they share the object id.
 */
export function buildCoverageIndex(summaryPayload) {
  const index = new Map();
  if (!summaryPayload || !Array.isArray(summaryPayload.objects)) return index;
  for (const object of summaryPayload.objects) {
    const entry = {
      objectKey: object.objectKey,
      objectType: object.objectType,
      district: object.district ?? null,
      label: object.label || '',
    };
    const perPoint = new Map();
    for (const photo of object.photos || []) {
      const sourceId = photo?.sourceId;
      if (!sourceId) continue;
      const counts = perPoint.get(sourceId) || { confirmed: 0, pending: 0 };
      if (photo.reviewStatus === 'confirmed') counts.confirmed += 1;
      else if (photo.reviewStatus !== 'rejected') counts.pending += 1;
      perPoint.set(sourceId, counts);
    }
    for (const sourceId of object.sourceIds || []) {
      const counts = perPoint.get(sourceId) || { confirmed: 0, pending: 0 };
      index.set(sourceId, { ...entry, confirmedPhotos: counts.confirmed, pendingReviewPhotos: counts.pending });
    }
  }
  return index;
}

export function coverageFor(coverageIndex, record, objectType) {
  const entry = coverageIndex.get(record.id) || null;
  const required = photoRequirementFor(objectType);
  const confirmed = entry ? entry.confirmedPhotos : 0;
  const pending = entry ? entry.pendingReviewPhotos : 0;
  const complete = confirmed >= required;
  const statusKey = complete ? 'done' : confirmed > 0 ? 'partial' : pending > 0 ? 'pending' : 'empty';
  return {
    required,
    confirmed,
    pending,
    withPhoto: confirmed + pending > 0,
    complete,
    // Уже снятое, но ещё не подтверждённое тоже закрывает норму съёмки: иначе
    // район отправляли бы снимать точку второй раз, пока приёмка не разобрала первую.
    remaining: Math.max(0, required - confirmed - pending),
    statusKey,
    statusLabel: statusText(statusKey),
    district: entry ? entry.district : null,
    objectKey: entry ? entry.objectKey : null,
  };
}

export function groupValues(records) {
  return [...new Set(records.map((record) => record.group).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'ru'));
}

function normalizeText(value) {
  return String(value || '').toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
}

export function recordMatches(record, query, searchKeyFallback) {
  if (!query) return true;
  const source = record.searchKey || searchKeyFallback || `${record.label || ''} ${record.group || ''}`;
  return normalizeText(source).includes(normalizeText(query));
}

/**
 * Filter the current dataset by free text, group, district and photo status.
 * `district` is only offered to a prefecture role; a district role is scoped server side.
 */
export function filterRecords(records, options = {}) {
  const { query = '', group = '', district = '', status = 'all', objectKeys = null } = options;
  const { coverageIndex, objectType } = options;
  return records.filter((record) => {
    if (!recordMatches(record, query)) return false;
    if (group && record.group !== group) return false;
    const coverage = coverageFor(coverageIndex, record, objectType);
    // Учётка АвД ведёт объекты по всему округу: их список приходит из сводки.
    if (objectKeys && !objectKeys.has(coverage.objectKey)) return false;
    if (district && !sameDistrict(coverage.district, district)) return false;
    // Объекты владельца «АвД САО» и «ДЭУ» к району не относятся: они идут за АвД
    // и в районном списке не показываются.
    if (district && isAutodorHolder(recordHolder(record))) return false;
    if (status === 'without' && coverage.withPhoto) return false;
    if (status === 'with' && !coverage.withPhoto) return false;
    if (status === 'done' && !coverage.complete) return false;
    if (status === 'partial' && coverage.statusKey !== 'partial') return false;
    if (status === 'pending' && coverage.pending === 0) return false;
    return true;
  });
}

/**
 * Build the mobile route queue: objects that still need confirmed photos, kept in
 * group order so one walk covers a single group before moving on.
 */
export function buildQueue(records, options = {}) {
  const { coverageIndex, objectType } = options;
  return records
    .filter((record) => !coverageFor(coverageIndex, record, objectType).complete)
    .slice()
    .sort((left, right) => {
      const group = String(left.group || '').localeCompare(String(right.group || ''), 'ru');
      if (group !== 0) return group;
      return String(left.label || '').localeCompare(String(right.label || ''), 'ru');
    });
}

/**
 * Охват — доля объектов, по которым район уже загрузил хотя бы одно фото.
 * Именно по нему видно работу районов: подтверждений приёмки может не быть
 * неделями, а снимки уже лежат на проверке. В штабной таблице тот же счёт.
 */
export function coveragePercent(summary) {
  const total = Number(summary?.totalObjects) || 0;
  if (!total) return 0;
  return Math.round(((Number(summary.objectsWithPhoto) || 0) / total) * 100);
}

export function coverageBand(percent) {
  if (percent < 33) return 'low';
  if (percent < 66) return 'middle';
  return 'high';
}

export function coverageLabel(summary) {
  if (!Number(summary?.totalObjects)) return 'нет данных';
  return `${coveragePercent(summary)} %`;
}

// /reports/summary nests the SAO-wide counters under `overall`, so the rows are read
// from that object instead of the payload root.
export function reportSummaryRows(payload) {
  const summary = payload?.overall;
  if (!summary) return [];
  const band = coverageBand(coveragePercent(summary));
  const rows = [
    { key: 'Всего объектов', value: String(summary.totalObjects ?? 0) },
    { key: 'С фото', value: String(summary.objectsWithPhoto ?? 0) },
    { key: 'Без фото', value: String(summary.objectsWithoutPhoto ?? 0) },
    { key: 'Охват', value: coverageLabel(summary) },
    { key: 'На проверке', value: String(summary.pendingReviewObjects ?? 0) },
    { key: 'Подтверждено приёмкой', value: String(summary.completedObjects ?? 0) },
    { key: 'Статус', value: `${bandText(band)} — ${bandNote(band)}` },
  ];
  return rows;
}

// The dataset payload carries the group label under a dataset-specific name.
export function groupLabel(dataset) {
  return dataset.groupLabel || 'Группа';
}

/**
 * Convert the district polygons for the map.
 *
 * GeoJSON stores [longitude, latitude] while Yandex Maps expects [latitude, longitude],
 * so the swap happens here and the drawing code stays trivial and testable. A district
 * cut by a water mask arrives as a MultiPolygon, so every part becomes its own shape.
 */
export function districtBoundaries(geojson, districts) {
  if (!geojson || !Array.isArray(geojson.features)) return [];
  const wanted = Array.isArray(districts) && districts.length ? new Set(districts) : null;
  const boundaries = [];
  for (const feature of geojson.features) {
    const district = feature?.properties?.district;
    if (!district || (wanted && !wanted.has(district))) continue;
    const type = feature?.geometry?.type;
    const polygons = type === 'Polygon' ? [feature.geometry.coordinates]
      : type === 'MultiPolygon' ? feature.geometry.coordinates
        : [];
    for (const rings of polygons) {
      boundaries.push({
        district,
        rings: rings.map((ring) => ring.map(([longitude, latitude]) => [latitude, longitude])),
      });
    }
  }
  return boundaries;
}

export function boundaryNote(districts, totalDistricts) {
  if (!districts || districts.length === 0) return 'Границы районов не показаны.';
  if (districts.length === 1) return `Показана граница района: ${districts[0]}.`;
  if (districts.length === totalDistricts) return `Показаны границы всех ${totalDistricts} районов.`;
  return `Показаны границы районов: ${districts.join(', ')}.`;
}

// A district account may only work with its own district.
export function scopedDistricts(user, selectedDistrict, allDistricts) {
  if (user?.role === 'district_editor') {
    // Учётка владельца работает по всему округу, поэтому ей показываем все границы.
    if (isAutodorAccount(user.district)) return allDistricts || [];
    return user.district ? [user.district] : [];
  }
  if (selectedDistrict) return [selectedDistrict];
  return allDistricts;
}

/** Название учётки владельца: она ведёт свои объекты во всех районах. */
export const AUTODOR_ACCOUNT = 'АвД САО';

export function isAutodorAccount(district) {
  return String(district ?? '').trim().toLowerCase() === AUTODOR_ACCOUNT.toLowerCase();
}

/**
 * Сравнение район подписи объекта с районом учётки. Район учётки вводит
 * администратор, а район объекта приходит из границ: расхождение в регистре или
 * в «ё» не должно давать пустой список у района, который вошёл успешно.
 */
export function normalizeDistrict(value) {
  return String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е');
}

export function sameDistrict(left, right) {
  const first = normalizeDistrict(left);
  const second = normalizeDistrict(right);
  return Boolean(first) && first === second;
}

// Балансодержатель лежит в свойствах под разными именами по наборам: у остановок
// «Балансодержатель», у переходов «Баланс». У подъездов своего владельца нет.
export function recordHolder(record) {
  const properties = record?.properties || {};
  return properties['Балансодержатель'] ?? properties['Баланс'] ?? '';
}

/**
 * Объект принадлежит владельцу «АвД САО» или «ДЭУ N», а не району, где стоит.
 * Такие объекты ведёт учётка АвД: район их не снимает и в своём списке не видит.
 * Правило то же, что на сервере (`isAutodorHolder` в photo-service/src/scope.js).
 */
export function isAutodorHolder(holder) {
  const value = String(holder ?? '').trim().toLowerCase();
  return value === 'авд сао' || value.startsWith('дэу');
}

/**
 * Границы выборки для учётки. Районная учётка ходит по своему району, а учётка
 * АвД — по списку своих объектов из сводки: её объекты стоят в разных районах,
 * и фильтр по району показал бы пустой список.
 */
export function accountScope(user, summary) {
  if (user?.role !== 'district_editor') return { district: '', objectKeys: null };
  if (isAutodorAccount(user.district)) {
    const objectKeys = new Set((summary?.objects || []).map((object) => object.objectKey).filter(Boolean));
    return { district: '', objectKeys };
  }
  return { district: user.district || '', objectKeys: null };
}

export function canExport(user) {
  return user?.role === 'prefecture_admin';
}

/* --------------------------------------------------------------- geo check */

const EARTH_RADIUS_METERS = 6_371_008.8;
export const NOMINAL_RADIUS_METERS = 15;
// Разброс ±15 м: граница зоны 30 м. Должно совпадать с сервером
// (DEFAULT_TOLERANCE_METERS в photo-service/src/geo.js).
export const GPS_TOLERANCE_METERS = 15;

export function haversineDistanceMeters(first, second) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/**
 * The same verdict the service computes on upload, so the distance shown before
 * sending matches the geo status stored afterwards. Only the nearest registered
 * point is used; this is an approximation and not polygon containment.
 */
export function assessDistanceRisk(position, referencePoints, radiusMeters = NOMINAL_RADIUS_METERS, toleranceMeters = GPS_TOLERANCE_METERS) {
  if (position === null || position === undefined) return { status: 'review', reason: 'missing_gps' };
  if (!Array.isArray(referencePoints) || referencePoints.length === 0) return { status: 'review', reason: 'missing_reference_points' };

  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const referencePoint of referencePoints) {
    if (!Number.isFinite(referencePoint?.latitude) || !Number.isFinite(referencePoint?.longitude)) continue;
    const distance = haversineDistanceMeters(position, referencePoint);
    if (distance < nearestDistance) nearestDistance = distance;
  }
  if (!Number.isFinite(nearestDistance)) return { status: 'review', reason: 'missing_reference_points' };

  const effectiveRadiusMeters = radiusMeters + toleranceMeters;
  const risk = nearestDistance > effectiveRadiusMeters;
  return {
    status: nearestDistance <= radiusMeters ? 'within_radius' : (risk ? 'risk' : 'within_tolerance'),
    risk,
    distanceMeters: nearestDistance,
    radiusMeters,
    toleranceMeters,
    effectiveRadiusMeters,
  };
}

// Shown next to the GPS fix so a worker sees the distance before pressing send.
export function gpsDistanceLabel(position, referencePoints) {
  const assessment = assessDistanceRisk(position, referencePoints);
  if (!Number.isFinite(assessment.distanceMeters)) {
    return 'Расстояние до объекта не определено: нет зарегистрированных точек.';
  }
  return `До объекта ${formatMeters(assessment.distanceMeters)} — ${geoStatusText(assessment.status).toLowerCase()}.`;
}
