/**
 * Автоматическое выявление рисков фотофиксации.
 *
 * «Риск» — это неполное или недобросовестное исполнение задания. Статус
 * присваивается автоматически: если фиксация попадает в категорию, она
 * оказывается в списке рисков. Ручного разбора статуса нет.
 *
 * Модуль намеренно чистый: он не ходит в базу и не читает файлы, поэтому
 * проверяется тестами без поднятия службы.
 */

/** Порог зоны: номинальный радиус 15 м плюс допуск 5 м. */
export const ZONE_LIMIT_METERS = 20;

export const RISK_KINDS = {
  zone_overflow: 'Превышение зоны',
  duplicate_photo: 'Дубль фото на разных объектах',
};

/** Балансодержатель лежит в свойствах объекта под разными именами по наборам. */
const BALANCE_HOLDER_KEYS = ['Балансодержатель', 'Баланс', 'balance_holder'];
const ODH_ID_KEYS = ['ID объекта ОДХ', 'odh_id'];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Балансодержатель объекта. Готовое значение приходит из выборки отчёта; если
 * его нет, смотрим свойства, а для подъездов, где своего балансодержателя в
 * источнике нет, подставляем «Жилищник «Район»» — так же, как это поле названо
 * в редакторе правок ОДХ.
 */
export function balanceHolderOf(object) {
  const properties = object?.properties || {};
  const direct = text(object?.balanceHolder);
  if (direct) return direct;
  for (const key of BALANCE_HOLDER_KEYS) {
    const value = text(properties[key]);
    if (value) return value;
  }
  const district = text(object?.district) || text(properties['Район']);
  return district ? `Жилищник «${district}»` : null;
}

export function odhIdOf(object) {
  const direct = object?.odhId;
  if (direct !== undefined && direct !== null && direct !== '') return String(direct).trim();
  const properties = object?.properties || {};
  for (const key of ODH_ID_KEYS) {
    const value = properties[key];
    if (value === undefined || value === null || value === '') continue;
    return String(value).trim();
  }
  return null;
}

function firstReferencePoint(object) {
  const points = Array.isArray(object?.reference_points) ? object.reference_points : [];
  const point = points[0];
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;
  return { latitude: point.latitude, longitude: point.longitude };
}

function baseRecord(object, photo) {
  const reference = firstReferencePoint(object);
  const distance = Number.isFinite(photo?.distanceM) ? photo.distanceM : null;
  return {
    kind: null,
    kindLabel: null,
    detectedAt: photo?.uploadedAt || null,
    district: object?.district || null,
    balanceHolder: balanceHolderOf(object),
    objectKey: object?.objectKey || null,
    objectLabel: object?.label || null,
    objectType: object?.objectType || null,
    odhId: odhIdOf(object),
    objectPoint: reference,
    performer: photo?.performer || null,
    gps: {
      latitude: Number.isFinite(photo?.gpsLatitude) ? photo.gpsLatitude : null,
      longitude: Number.isFinite(photo?.gpsLongitude) ? photo.gpsLongitude : null,
      accuracyM: Number.isFinite(photo?.gpsAccuracyM) ? photo.gpsAccuracyM : null,
    },
    distanceM: distance,
    overMeters: null,
    photoIds: photo?.id ? [photo.id] : [],
    photoFiles: photo?.id ? [{ id: photo.id, thumbnailKey: photo.thumbnailKey || null, storageKey: photo.storageKey || null }] : [],
    statusLabel: 'Риск',
  };
}

/**
 * Собирает риски из объектов отчёта.
 *
 * @param {Array} objects объекты отчёта с фотографиями
 * @param {{zoneLimitMeters?: number}} options
 */
export function collectRisks(objects, { zoneLimitMeters = ZONE_LIMIT_METERS } = {}) {
  const risks = [];
  const bySha = new Map();

  for (const object of objects || []) {
    for (const photo of object?.photos || []) {
      if (!photo?.sha256) continue;
      if (!bySha.has(photo.sha256)) bySha.set(photo.sha256, []);
      bySha.get(photo.sha256).push({ object, photo });
    }
  }

  // 1. Превышение зоны: датчик ушёл дальше 20 м от объекта.
  for (const object of objects || []) {
    for (const photo of object?.photos || []) {
      if (photo?.geoStatus !== 'risk') continue;
      const record = baseRecord(object, photo);
      record.kind = 'zone_overflow';
      record.kindLabel = RISK_KINDS.zone_overflow;
      record.overMeters = Number.isFinite(photo.distanceM)
        ? Math.round((photo.distanceM - zoneLimitMeters) * 10) / 10
        : null;
      risks.push(record);
    }
  }

  // 2. Точный дубль файла, попавший на разные объекты. Один и тот же объект
  //    дважды — не нарушение: так бывает при повторной съёмке.
  for (const [sha256, group] of bySha) {
    const objectKeys = new Set(group.map((entry) => entry.object.objectKey));
    if (objectKeys.size < 2) continue;
    for (const { object, photo } of group) {
      const record = baseRecord(object, photo);
      record.kind = 'duplicate_photo';
      record.kindLabel = RISK_KINDS.duplicate_photo;
      record.photoIds = group.map((entry) => entry.photo.id);
      record.photoFiles = group.map((entry) => ({
        id: entry.photo.id,
        thumbnailKey: entry.photo.thumbnailKey || null,
        storageKey: entry.photo.storageKey || null,
      }));
      record.duplicateObjects = [...objectKeys];
      record.sha256 = sha256;
      risks.push(record);
    }
  }

  return risks.sort((left, right) => String(right.detectedAt || '').localeCompare(String(left.detectedAt || '')));
}

/** Сводка рисков по категориям: для листа «Риск» и блока в «Обзоре». */
export function summarizeRisks(risks) {
  const byKind = new Map();
  for (const risk of risks || []) {
    const current = byKind.get(risk.kind) || { kind: risk.kind, kindLabel: risk.kindLabel, count: 0 };
    current.count += 1;
    byKind.set(risk.kind, current);
  }
  return {
    total: (risks || []).length,
    byKind: [...byKind.values()].sort((left, right) => right.count - left.count),
  };
}
