// Страница отдела МКД: фото первых этажей подъездов.
//
// Чистые функции без DOM и сети: отбор подъездов, статус точки и тексты
// счётчиков. Фото первых этажей — отдельный учёт, поэтому здесь нет ни нормы,
// ни приёмки: у подъезда фото либо есть (от 1 до 10), либо нет.

import { recordMatches, sameDistrict } from './photo-model.js';

export const MKD_CATEGORY = 'Первый этаж';
export const MKD_PHOTO_LIMIT = 10;
export const MKD_STATUS_COLOR = Object.freeze({ with: '#0c7a5a', without: '#b4552f' });

/** Может ли учётка загружать и удалять фото первого этажа. */
export function mkdCanWrite(user) {
  return user?.role === 'mkd_editor';
}

/** Может ли учётка открыть раздел: сам отдел и префектура (только просмотр). */
export function mkdCanView(user) {
  return user?.role === 'mkd_editor' || user?.role === 'prefecture_admin';
}

/** Сколько фото первого этажа у подъезда по сводке. */
export function mkdPhotoCount(summary, recordId) {
  return Number(summary?.points?.[recordId]) || 0;
}

export function mkdStatusKey(summary, recordId) {
  return mkdPhotoCount(summary, recordId) > 0 ? 'with' : 'without';
}

/** Район подъезда — из данных слоя: у подъездов нет владельца «АвД». */
export function mkdRecordDistrict(record) {
  return record?.group || record?.properties?.['Район'] || '';
}

/** Отбор подъездов по поиску, району и наличию фото первого этажа. */
export function filterMkdRecords(records, { query = '', district = '', status = 'all', summary = null } = {}) {
  return (records || []).filter((record) => {
    if (!recordMatches(record, query)) return false;
    if (district && !sameDistrict(mkdRecordDistrict(record), district)) return false;
    const count = mkdPhotoCount(summary, record.id);
    if (status === 'with' && count === 0) return false;
    if (status === 'without' && count > 0) return false;
    return true;
  });
}

/** Счётчик по отобранным подъездам: столько с фото, столько без. */
export function mkdCounters(records, summary) {
  let withPhoto = 0;
  let photos = 0;
  for (const record of records || []) {
    const count = mkdPhotoCount(summary, record.id);
    if (count > 0) withPhoto += 1;
    photos += count;
  }
  const total = (records || []).length;
  return {
    total,
    withPhoto,
    without: total - withPhoto,
    photos,
    percent: total > 0 ? Math.round((withPhoto / total) * 100) : 0,
  };
}

export function mkdCounterText(counters) {
  const number = (value) => Number(value || 0).toLocaleString('ru-RU');
  return `С фото первого этажа: ${number(counters.withPhoto)} из ${number(counters.total)} (${counters.percent} %)`
    + ` · осталось: ${number(counters.without)} · всего фото: ${number(counters.photos)}`;
}

/** Строка в карточке: сколько ещё фото можно прикрепить. */
export function mkdLimitText(count) {
  const left = Math.max(0, MKD_PHOTO_LIMIT - (Number(count) || 0));
  if (left === 0) return `Прикреплено ${MKD_PHOTO_LIMIT} из ${MKD_PHOTO_LIMIT} фото — это предел. Чтобы добавить новое, удалите лишнее.`;
  return `Прикреплено ${count} из ${MKD_PHOTO_LIMIT} фото · можно добавить ещё ${left}.`;
}

/** Сколько из выбранных файлов поместится: лишние не отправляем вовсе. */
export function mkdFilesToSend(selectedCount, existingCount) {
  const room = Math.max(0, MKD_PHOTO_LIMIT - (Number(existingCount) || 0));
  return Math.min(Number(selectedCount) || 0, room);
}
