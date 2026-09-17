/**
 * Автоматические проверки фотофиксации.
 *
 * Раньше здесь были ещё две категории «риска» — превышение зоны GPS и
 * недостоверная геопривязка. От них отказались: GPS не объективный показатель
 * (в плотной застройке координаты уходят на десятки метров, часть районов
 * снимает без геолокации вовсе), и «риск» по нему вводил в заблуждение.
 * Осталась одна проверка, которая к GPS не относится: точный дубль файла,
 * прикреплённый к разным объектам.
 *
 * Модуль намеренно чистый: он не ходит в базу и не читает файлы, поэтому
 * проверяется тестами без поднятия службы.
 */

import { reportingDistrict } from './scope.js';

export const CHECK_KINDS = {
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
    distanceM: Number.isFinite(photo?.distanceM) ? photo.distanceM : null,
    photoIds: photo?.id ? [photo.id] : [],
    photoFiles: photo?.id ? [{ id: photo.id, thumbnailKey: photo.thumbnailKey || null, storageKey: photo.storageKey || null }] : [],
    statusLabel: 'Проверка',
  };
}

/**
 * Точный дубль файла, попавший на разные объекты. Один и тот же объект дважды —
 * не нарушение: так бывает при повторной съёмке одной точки.
 */
export function collectChecks(objects) {
  const grouped = new Map();
  for (const object of objects || []) {
    for (const photo of object?.photos || []) {
      if (!photo?.sha256) continue;
      if (!grouped.has(photo.sha256)) grouped.set(photo.sha256, []);
      grouped.get(photo.sha256).push({ object, photo });
    }
  }

  const checks = [];
  for (const [sha256, group] of grouped) {
    const objectKeys = new Set(group.map((entry) => entry.object.objectKey));
    if (objectKeys.size < 2) continue;
    for (const { object, photo } of group) {
      const record = baseRecord(object, photo);
      record.kind = 'duplicate_photo';
      record.kindLabel = CHECK_KINDS.duplicate_photo;
      record.photoIds = group.map((entry) => entry.photo.id);
      record.photoFiles = group.map((entry) => ({
        id: entry.photo.id,
        thumbnailKey: entry.photo.thumbnailKey || null,
        storageKey: entry.photo.storageKey || null,
      }));
      record.duplicateObjects = [...objectKeys];
      record.sha256 = sha256;
      checks.push(record);
    }
  }

  return checks.sort((left, right) => String(right.detectedAt || '').localeCompare(String(left.detectedAt || '')));
}

/** Сводка проверок по категориям: для листа «Проверки» и блока в «Обзоре». */
export function summarizeChecks(checks) {
  const byKind = new Map();
  for (const check of checks || []) {
    const current = byKind.get(check.kind) || { kind: check.kind, kindLabel: check.kindLabel, count: 0 };
    current.count += 1;
    byKind.set(check.kind, current);
  }
  return {
    total: (checks || []).length,
    byKind: [...byKind.values()].sort((left, right) => right.count - left.count),
  };
}

/** Число проверок по районам: район считается тем же правилом, что в отчётах. */
export function checksByDistrict(checks) {
  const byDistrict = new Map();
  for (const check of checks || []) {
    const district = reportingDistrict(check);
    byDistrict.set(district, (byDistrict.get(district) || 0) + 1);
  }
  return byDistrict;
}

/** Число проверок по объектам: для колонки в реестре объектов. */
export function checksByObject(checks) {
  const byObject = new Map();
  for (const check of checks || []) {
    if (!check.objectKey) continue;
    byObject.set(check.objectKey, (byObject.get(check.objectKey) || 0) + 1);
  }
  return byObject;
}
