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

import { reportingDistrict } from './scope.js';

/**
 * Граница зоны: номинальный радиус 15 м плюс разброс ±15 м.
 * Должна совпадать с DEFAULT_RADIUS_METERS + DEFAULT_TOLERANCE_METERS в geo.js.
 */
export const ZONE_LIMIT_METERS = 30;

/**
 * Точность, после которой фиксация не считается привязанной к месту.
 * Браузер без спутников отдаёт позицию по IP: точка одна на весь город, а
 * точность измеряется сотнями километров. Такую фиксацию нельзя ни принять,
 * ни считать нарушением зоны — она отдельная категория.
 */
export const ACCURACY_LIMIT_METERS = 100;

export const RISK_KINDS = {
  unreliable_geo: 'Недостоверная геопривязка',
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

  // 1. Геопривязка. Сначала проверяется достоверность самой точки: если точность
  //    прибора измеряется сотнями метров, расстояние до объекта ничего не
  //    доказывает, и такая фиксация идёт отдельной категорией, а не «превышением».
  for (const object of objects || []) {
    for (const photo of object?.photos || []) {
      const record = baseRecord(object, photo);
      const accuracy = photo?.gpsAccuracyM;
      const unreliable = !Number.isFinite(accuracy) || accuracy > ACCURACY_LIMIT_METERS;
      const distance = Number.isFinite(photo?.distanceM) ? photo.distanceM : null;

      if (unreliable) {
        record.kind = 'unreliable_geo';
        record.kindLabel = RISK_KINDS.unreliable_geo;
        record.overMeters = null;
        risks.push(record);
        continue;
      }
      if (distance === null || distance <= zoneLimitMeters) continue;
      record.kind = 'zone_overflow';
      record.kindLabel = RISK_KINDS.zone_overflow;
      record.overMeters = Math.round((distance - zoneLimitMeters) * 10) / 10;
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

/**
 * Топы по нарушениям для выгрузок и дашборда: районы по числу рисков и
 * исполнители внутри каждого района. Район считается по тому же правилу, что и
 * в штабной таблице, — объекты владельца, «ДЭУ» и объекты без района попадают
 * в строку «АвД САО», а не в район, где стоят.
 */
export function riskTops(risks, { performerLimit = 5 } = {}) {
  const districts = new Map();
  for (const risk of risks || []) {
    const district = reportingDistrict(risk);
    if (!districts.has(district)) districts.set(district, { district, count: 0, performers: new Map() });
    const entry = districts.get(district);
    entry.count += 1;
    const performer = text(risk.performer) || 'Исполнитель не указан';
    entry.performers.set(performer, (entry.performers.get(performer) || 0) + 1);
  }

  const ordered = [...districts.values()]
    .sort((left, right) => right.count - left.count || left.district.localeCompare(right.district, 'ru'))
    .map((entry) => ({
      district: entry.district,
      count: entry.count,
      performers: [...entry.performers.entries()]
        .map(([performer, count]) => ({ performer, count }))
        .sort((left, right) => right.count - left.count || left.performer.localeCompare(right.performer, 'ru'))
        .slice(0, performerLimit),
    }));

  return { total: (risks || []).length, districts: ordered, performerLimit };
}
