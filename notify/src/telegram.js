// Связь с Telegram бывает недоступна нестабильно: часть попыток обрывается по
// таймауту. Ответ самой службы приходит как «Telegram <method>: …» — такие
// ошибки не повторяем, а сетевые сбои пробуем ещё несколько раз.
const RETRY_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1500;

export function createTelegram({ token, fetchImpl = fetch, apiBase = 'https://api.telegram.org', sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!token) throw new Error('Токен бота не задан.');

  const isNetworkError = (error) => !/^Telegram /.test(String(error?.message || ''));

  const withRetry = async (operation) => {
    let lastError;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isNetworkError(error) || attempt === RETRY_ATTEMPTS) throw error;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    throw lastError;
  };

  const call = async (method, payload = {}) => withRetry(async () => {
    const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new Error(`Telegram ${method}: ${body?.description || `HTTP ${response.status}`}`);
    }
    return body.result;
  });

  const sendPhoto = async (chatId, { buffer, filename = 'photo.png', caption }) => withRetry(async () => {
    // Фотография отправляется multipart-запросом, а не JSON: так Telegram
    // получает файл целиком, без ограничений на длину строки.
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', String(caption).slice(0, 1024));
      form.append('parse_mode', 'HTML');
    }
    form.append('photo', new Blob([buffer], { type: 'image/png' }), filename);
    const response = await fetchImpl(`${apiBase}/bot${token}/sendPhoto`, { method: 'POST', body: form });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new Error(`Telegram sendPhoto: ${body?.description || `HTTP ${response.status}`}`);
    }
    return body.result;
  });

  return {
    call,
    sendPhoto,
    sendMessage: (chatId, text, options = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      }),
    editMessageText: (chatId, messageId, text, options = {}) =>
      call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      }),
    answerCallbackQuery: (callbackQueryId, text) =>
      call('answerCallbackQuery', { callback_query_id: callbackQueryId, text }),
    getUpdates: (offset, timeout, signal) =>
      call('getUpdates', {
        offset,
        timeout,
        allowed_updates: ['message', 'callback_query']
      }),
    setMyCommands: (commands) => call('setMyCommands', { commands })
  };
}
