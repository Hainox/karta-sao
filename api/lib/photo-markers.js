import { isPointWithinBoundary } from './validation.js';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function finiteCoordinate(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function validatePhotoMarker(input, boundary) {
  const longitude = Number(input?.longitude);
  const latitude = Number(input?.latitude);
  const note = String(input?.note || '').trim();
  const errors = [];
  if (!finiteCoordinate(longitude, -180, 180) || !finiteCoordinate(latitude, -90, 90)) errors.push('Координаты фото-метки некорректны.');
  else if (!isPointWithinBoundary([longitude, latitude], boundary)) errors.push('Фото-метка должна находиться в границе САО.');
  if (note.length > 2000) errors.push('Заметка к фото-метке не должна быть длиннее 2 000 символов.');
  const legacySourceId = input?.legacy_source_id == null ? null : String(input.legacy_source_id).trim();
  if (legacySourceId && legacySourceId.length > 120) errors.push('Идентификатор переноса слишком длинный.');
  return { valid: !errors.length, errors, value: { longitude, latitude, note, legacySourceId: legacySourceId || null } };
}

export function validatePhotoNote(note) {
  if (typeof note !== 'string') return { valid: false, error: 'Заметка должна быть строкой.' };
  const value = note.trim();
  if (value.length > 2000) return { valid: false, error: 'Заметка к фото-метке не должна быть длиннее 2 000 символов.' };
  return { valid: true, value };
}

function detectedMimeType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function validatePhotoUpload(bytes, declaredMimeType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return { valid: false, error: 'Прикрепите непустой файл изображения.' };
  if (bytes.length > MAX_PHOTO_BYTES) return { valid: false, error: 'Фото не должно быть больше 5 МБ.' };
  const mimeType = detectedMimeType(bytes);
  if (!mimeType || !PHOTO_MIME_TYPES.has(String(declaredMimeType).toLowerCase()) || mimeType !== String(declaredMimeType).toLowerCase()) {
    return { valid: false, error: 'Допустимы только корректные JPEG, PNG или WebP.' };
  }
  return { valid: true, mimeType };
}

export function safePhotoFilename(value) {
  let decoded = String(value || 'photo');
  try { decoded = decodeURIComponent(decoded); } catch (_) { /* keep the raw header value */ }
  const filename = decoded.trim().replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180);
  return filename || 'photo';
}
