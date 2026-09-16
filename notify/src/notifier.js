import { keyboardFor, renderAction, renderEvent, renderQuestion } from './events.js';

export function createNotifier({ config, telegram, store }) {
  const recipients = (chatIds) => (chatIds?.length ? chatIds : config.allowedChatIds);

  return {
    async publish(event, { chatIds } = {}) {
      const text = renderEvent(event);
      const record = await store.appendJournal({ direction: 'out', type: 'event', event, text });
      const delivered = [];
      for (const chatId of recipients(chatIds)) {
        const message = await telegram.sendMessage(chatId, text);
        delivered.push({ chatId, messageId: message?.message_id });
      }
      return { record, delivered };
    },

    /** Картинка с подписью: сводка штаба уходит фотографией в тот же чат. */
    async photo({ photo, caption, filename, chatIds } = {}) {
      if (!photo) throw new Error('Нужна картинка в поле photo (base64).');
      const buffer = Buffer.from(String(photo), 'base64');
      const record = await store.appendJournal({ direction: 'out', type: 'photo', caption, bytes: buffer.length });
      const delivered = [];
      for (const chatId of recipients(chatIds)) {
        const message = await telegram.sendPhoto(chatId, { buffer, filename, caption });
        delivered.push({ chatId, messageId: message?.message_id });
      }
      return { record, delivered };
    },

    async ask({ question, details, options, timeoutSeconds, chatIds }, { action } = {}) {
      if (!question) throw new Error('Вопрос не может быть пустым.');
      const list = (options || []).filter(Boolean);
      if (!list.length) throw new Error('Нужен хотя бы один вариант ответа.');
      const pending = await store.addPending({
        kind: 'question',
        question,
        details,
        options: list.map((option) => ({ text: String(option.text ?? option.value ?? option), value: String(option.value ?? option.text ?? option) })),
        chatIds: recipients(chatIds),
        action: action || null,
        expiresAt: new Date(Date.now() + (timeoutSeconds || config.answerTimeoutSeconds) * 1000).toISOString()
      });
      const text = renderQuestion(pending);
      const delivered = [];
      for (const chatId of pending.chatIds) {
        const message = await telegram.sendMessage(chatId, text, { reply_markup: keyboardFor(pending) });
        delivered.push({ chatId, messageId: message?.message_id });
      }
      await store.updatePending(pending.id, { delivered });
      return { pending, delivered };
    },

    async requestAction({ name, title, details, payload, confirmText, timeoutSeconds, chatIds }) {
      if (!name || !title) throw new Error('У действия должны быть имя и описание.');
      const pending = await store.addPending({
        kind: 'action',
        action: { name, payload: payload || {} },
        title,
        details,
        confirmText,
        chatIds: recipients(chatIds),
        expiresAt: new Date(Date.now() + (timeoutSeconds || config.answerTimeoutSeconds) * 1000).toISOString()
      });
      const text = renderAction(pending);
      const delivered = [];
      for (const chatId of pending.chatIds) {
        const message = await telegram.sendMessage(chatId, text, { reply_markup: keyboardFor(pending) });
        delivered.push({ chatId, messageId: message?.message_id });
      }
      await store.updatePending(pending.id, { delivered });
      return { pending, delivered };
    }
  };
}
