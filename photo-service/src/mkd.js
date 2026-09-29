// Отдел МКД: фото первых этажей подъездов.
//
// Это отдельная работа, а не часть фотофиксации: у неё нет нормы, приёмки,
// «На штаб» и рассылок. Фото лежат в таблице `mkd_floor_photos`, которую не
// читает ни один отчёт фотофиксации, а учётка отдела видит только свои ручки
// `/mkd/…` — остановки, ПП, сводки и проверка ей закрыты на сервере.
//
// Здесь чистые правила: доступ, лимит и сводка. Их проверяют тесты без базы.

export const MKD_ROLE = 'mkd_editor';
export const MKD_DATASET_ID = 'injob_entrances';
// Первый этаж редко помещается в кадр целиком: холл, почтовые ящики, лестница.
export const MKD_PHOTO_LIMIT = 10;
export const MKD_CATEGORY = 'Первый этаж';
const NO_DISTRICT = 'Без района';

export const MKD_MESSAGES = Object.freeze({
  mkd_scope: 'Учётка отдела МКД работает только на странице «Первый этаж».',
  mkd_role_required: 'Раздел «Первый этаж» доступен отделу МКД и префектуре.',
  mkd_read_only: 'Префектура смотрит фото первых этажей, но не загружает и не удаляет их.',
  mkd_photo_limit: `К подъезду можно прикрепить не больше ${MKD_PHOTO_LIMIT} фото первого этажа.`,
  mkd_entrance_not_found: 'Подъезд не найден — обновите страницу.',
});

export function isMkdAccount(user) {
  return user?.role === MKD_ROLE;
}

/** Ручка относится к разделу МКД. */
export function isMkdPath(pathname) {
  return typeof pathname === 'string' && pathname.startsWith('/mkd/');
}

/**
 * Можно ли учётке идти в эту ручку. Учётке МКД открыты только `/auth/me` и
 * раздел `/mkd/…`; раздел МКД открыт только ей и префектуре. Вход и выход
 * проверяются раньше, до чтения сессии.
 */
export function mkdRouteVerdict(user, pathname) {
  if (isMkdAccount(user)) {
    if (pathname === '/auth/me' || isMkdPath(pathname)) return { ok: true };
    return { ok: false, status: 403, code: 'mkd_scope', message: MKD_MESSAGES.mkd_scope };
  }
  if (isMkdPath(pathname) && user?.role !== 'prefecture_admin') {
    return { ok: false, status: 403, code: 'mkd_role_required', message: MKD_MESSAGES.mkd_role_required };
  }
  return { ok: true };
}

/** Загружать и удалять фото первого этажа может только сам отдел. */
export function mkdWriteVerdict(user) {
  if (isMkdAccount(user)) return { ok: true };
  return { ok: false, status: 403, code: 'mkd_read_only', message: MKD_MESSAGES.mkd_read_only };
}

/** Хватает ли места под ещё одно фото у подъезда. */
export function mkdLimitVerdict(existingCount) {
  if (Number(existingCount) < MKD_PHOTO_LIMIT) return { ok: true };
  return { ok: false, status: 409, code: 'mkd_photo_limit', message: MKD_MESSAGES.mkd_photo_limit };
}

function percent(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/**
 * Сводка отдела: сколько подъездов уже с фото первого этажа — по округу и по
 * районам. Единица учёта — подъезд (точка на карте), а не фото.
 *
 * districtRows — `{ district, total }`: подъезды района из объектов;
 * photoRows — `{ source_id, district, photos, last_uploaded_at }`: по подъезду.
 */
export function mkdSummary(districtRows = [], photoRows = []) {
  const byDistrict = new Map();
  const rowFor = (name) => {
    const district = String(name ?? '').trim() || NO_DISTRICT;
    if (!byDistrict.has(district)) byDistrict.set(district, { district, total: 0, withPhoto: 0, photos: 0 });
    return byDistrict.get(district);
  };
  for (const row of districtRows) rowFor(row.district).total += Number(row.total) || 0;
  const points = {};
  for (const row of photoRows) {
    const count = Number(row.photos) || 0;
    if (!row.source_id || count <= 0) continue;
    points[row.source_id] = count;
    const target = rowFor(row.district);
    target.withPhoto += 1;
    target.photos += count;
  }
  const districts = [...byDistrict.values()]
    .map((row) => ({ ...row, without: Math.max(0, row.total - row.withPhoto), percent: percent(row.withPhoto, row.total) }))
    .sort((left, right) => (left.district === NO_DISTRICT) - (right.district === NO_DISTRICT)
      || left.district.localeCompare(right.district, 'ru'));
  const total = districts.reduce((sum, row) => sum + row.total, 0);
  const withPhoto = districts.reduce((sum, row) => sum + row.withPhoto, 0);
  const photos = districts.reduce((sum, row) => sum + row.photos, 0);
  return {
    category: MKD_CATEGORY,
    limit: MKD_PHOTO_LIMIT,
    overall: { total, withPhoto, without: Math.max(0, total - withPhoto), photos, percent: percent(withPhoto, total) },
    byDistrict: districts,
    points,
  };
}

/** Строка фото для клиента: без ключей хранилища. */
export function mkdPhotoPayload(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
    byteSize: Number(row.byte_size) || 0,
    performer: row.performer,
    comment: row.comment || '',
    capturedAt: row.captured_at,
    uploadedAt: row.uploaded_at,
    gpsLatitude: row.gps_latitude == null ? null : Number(row.gps_latitude),
    gpsLongitude: row.gps_longitude == null ? null : Number(row.gps_longitude),
    gpsAccuracyM: row.gps_accuracy_m == null ? null : Number(row.gps_accuracy_m),
  };
}

/**
 * Строки для архива: у каждого подъезда свои кадры. Раскладка архива та же,
 * что в фотофиксации (папка района → папка вида), вид — «Первый этаж».
 */
export function mkdArchiveRows(photoRows = []) {
  const bySource = new Map();
  for (const row of photoRows) {
    if (!bySource.has(row.source_id)) {
      bySource.set(row.source_id, {
        object_key: row.object_key,
        object_type: 'mkd_floor',
        district: row.district,
        label: row.label,
        reference_points: row.reference_points,
        photos: [],
      });
    }
    bySource.get(row.source_id).photos.push({
      id: row.id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      uploadedAt: row.uploaded_at,
      performer: row.performer,
      sha256: row.sha256,
      byteSize: row.byte_size,
      gpsLatitude: row.gps_latitude,
      gpsLongitude: row.gps_longitude,
    });
  }
  return [...bySource.values()];
}
