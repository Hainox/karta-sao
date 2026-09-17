/**
 * Правило отзыва кадра вынесено из сервера отдельной функцией: `server.js`
 * поднимает сокет при импорте, поэтому проверяется тестом только чистая логика.
 *
 * Отозвать можно лишь то, что ещё не проверено. Подтверждённое приёмкой фото
 * отзывать нельзя — иначе подтверждённая работа исчезала бы из отчётов молча;
 * повторный отзыв уже отозванного кадра безобиден (ответ «и так отозвано»).
 */
export const WITHDRAW_MESSAGES = {
  photo_already_confirmed: 'Фото уже подтверждено приёмкой — отозвать его нельзя, обратитесь в префектуру.',
  photo_not_pending: 'Отозвать можно только фото, которое ещё не проверено.',
  photo_already_rejected: 'Фото уже отклонено приёмкой — отзывать нечего.',
  photo_not_found: 'Фотография не найдена — обновите список.',
  out_of_scope: 'Это фото не относится к вашей зоне ответственности.',
};

/** Вердикт по отзыву: `{ ok: true }` либо `{ ok: false, status, code, message }`. */
export function photoWithdrawVerdict(photo, { canWithdraw = true } = {}) {
  if (!photo) {
    return { ok: false, status: 404, code: 'photo_not_found', message: WITHDRAW_MESSAGES.photo_not_found };
  }
  if (!canWithdraw) {
    return { ok: false, status: 403, code: 'object_out_of_scope', message: WITHDRAW_MESSAGES.out_of_scope };
  }
  if (photo.review_status === 'withdrawn') return { ok: true, already: true };
  if (photo.review_status === 'confirmed') {
    return { ok: false, status: 409, code: 'photo_already_confirmed', message: WITHDRAW_MESSAGES.photo_already_confirmed };
  }
  if (photo.review_status === 'rejected') {
    return { ok: false, status: 409, code: 'photo_not_pending', message: WITHDRAW_MESSAGES.photo_already_rejected };
  }
  if (photo.review_status !== 'pending_review') {
    return { ok: false, status: 409, code: 'photo_not_pending', message: WITHDRAW_MESSAGES.photo_not_pending };
  }
  return { ok: true, already: false };
}
