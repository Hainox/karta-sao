// Подписи отчётов: в PDF и в Excel одни и те же слова, без внутренних кодов.

const OBJECT_TYPE_LABELS = Object.freeze({ stop: 'Остановки', pp: 'ПП', entrance: 'Подъезды' });
const STATUS_BAND_LABELS = Object.freeze({ low: 'Красный', middle: 'Жёлтый', high: 'Зелёный' });

export function objectTypeLabel(type) {
  return OBJECT_TYPE_LABELS[type] || String(type);
}

export function statusBandLabel(band) {
  return STATUS_BAND_LABELS[band] || 'нет данных';
}

export function percentLabel(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'нет данных';
  return `${Number(value).toFixed(1).replace('.', ',')} %`;
}

export const OBJECT_TYPES = Object.freeze(Object.keys(OBJECT_TYPE_LABELS));
