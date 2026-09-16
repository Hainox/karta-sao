// Отправка событий в сервис оповещений.
//
// Уведомления не должны влиять на работу API: любой сбой отправки только
// пишется в лог, а ответ клиенту формируется как обычно.
export function createNotifyClient({ url, secret, fetchImpl = fetch, logger = console } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  const post = async (path, payload) => {
    if (!base) return null;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Notify-Secret': secret } : {}) },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        logger.warn?.(`Оповещение не принято: HTTP ${response.status}`);
        return null;
      }
      return await response.json().catch(() => null);
    } catch (error) {
      logger.warn?.(`Оповещение не отправлено: ${error.message}`);
      return null;
    }
  };

  return {
    enabled: Boolean(base),
    event: (payload) => post('/event', payload),
    action: (payload) => post('/action', payload),
    ask: (payload) => post('/ask', payload),
    // Выгрузка-отчёт уходит файлом в тот же чат: содержимое в base64, поле file.
    document: ({ file, filename, caption }) => post('/document', { file, filename, caption })
  };
}

export function notifyClientFromEnv(env = process.env, options = {}) {
  return createNotifyClient({ url: env.NOTIFY_URL, secret: env.NOTIFY_SECRET, ...options });
}
