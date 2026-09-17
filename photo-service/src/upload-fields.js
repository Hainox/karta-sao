/**
 * Обязательные поля отправки фото.
 *
 * Один код `dataset_source_performer_required` отвечал сразу за три разных случая
 * (нет набора, нет точки фиксации, пустой исполнитель). Клиент печатал код как
 * есть, поэтому район читал «что-то про исполнителя» даже когда дело было в
 * наборе или точке. Теперь у каждой причины свой код и русский текст.
 */
export const UPLOAD_FIELD_MESSAGES = {
  dataset_required: 'Не выбран набор данных — обновите страницу.',
  source_point_required: 'Не определена точка фиксации — выберите объект заново.',
  performer_required: 'Укажите исполнителя.',
};

/** Первое незаполненное поле отправки: код и текст, либо null. */
export function firstMissingUploadField({ datasetId, sourceId, performer } = {}) {
  const checks = [
    ['dataset_required', datasetId],
    ['source_point_required', sourceId],
    ['performer_required', performer],
  ];
  for (const [code, value] of checks) {
    if (!String(value ?? '').trim()) return { code, message: UPLOAD_FIELD_MESSAGES[code] };
  }
  return null;
}
