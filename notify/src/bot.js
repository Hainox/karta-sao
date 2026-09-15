import { isAllowedChat } from './config.js';
import { parseCallback } from './events.js';

const HELP = [
  '<b>Что умеет бот</b>',
  '• присылает отчёты о работе агента и событиях сервисов;',
  '• задаёт вопросы с кнопками и ждёт ответа;',
  '• просит подтверждение перед действием и выполняет его после нажатия.',
  '',
  '<b>Команды</b>',
  '/status — состояние оповещений и открытых вопросов',
  '/pending — что ждёт ответа',
  '/last — последние события',
  '/help — эта справка'
].join('\n');

export function createBot({ config, telegram, store, notifier, actions, logger = console }) {
  let offset = 0;
  let stopped = false;

  async function reply(chatId, text) {
    await telegram.sendMessage(chatId, text);
  }

  async function handleCommand(chatId, text) {
    const command = text.split(/\s+/)[0].toLowerCase();
    if (command === '/start' || command === '/help') {
      await reply(chatId, HELP);
      return;
    }
    if (command === '/status') {
      const pending = await store.listPending();
      const journal = await store.readJournal(1);
      await reply(chatId, [
        '🛠 <b>Оповещения работают</b>',
        `Открытых вопросов и подтверждений: ${pending.length}`,
        journal.length ? `Последнее событие: ${journal[0].at}` : 'Событий пока не было'
      ].join('\n'));
      return;
    }
    if (command === '/pending') {
      const pending = await store.listPending();
      if (!pending.length) {
        await reply(chatId, 'Открытых вопросов нет.');
        return;
      }
      await reply(chatId, pending.map((entry) => `• ${entry.kind === 'question' ? entry.question : entry.title} (${entry.id.slice(0, 8)})`).join('\n'));
      return;
    }
    if (command === '/last') {
      const journal = (await store.readJournal(10)).filter((entry) => entry.type === 'event');
      if (!journal.length) {
        await reply(chatId, 'Событий пока не было.');
        return;
      }
      await reply(chatId, journal.map((entry) => `<b>${entry.event?.kind || 'event'}</b> · ${entry.event?.title || ''}`).join('\n'));
      return;
    }
    await reply(chatId, 'Неизвестная команда. Наберите /help.');
  }

  async function resolveQuestion(pending, answer, { chatId, messageId, via }) {
    const closed = await store.closePending(pending.id, { status: 'answered', answer, via, chatId });
    await store.appendJournal({ direction: 'in', type: 'answer', pendingId: pending.id, answer, via, chatId, question: pending.question });
    const text = [`❓ <b>Вопрос</b>`, pending.question, '', `Ответ: <b>${answer}</b>`].join('\n');
    if (messageId) await telegram.editMessageText(chatId, messageId, text).catch(() => {});
    if (pending.action?.name && actions.has(pending.action.name)) {
      const result = await actions.run(pending.action.name, { ...(pending.action.payload || {}), answer });
      await store.appendJournal({ direction: 'out', type: 'action', name: pending.action.name, result, chatId });
      await reply(chatId, `Выполнено: ${result}`);
    }
    return closed;
  }

  async function handleCallback(query) {
    const chatId = String(query.message?.chat?.id);
    const messageId = query.message?.message_id;
    if (!isAllowedChat(config, chatId)) return;
    const parsed = parseCallback(query.data);
    if (!parsed) {
      await telegram.answerCallbackQuery(query.id, 'Кнопка устарела.');
      return;
    }
    const pending = await store.getPending(parsed.id);
    if (!pending || pending.status !== 'open') {
      await telegram.answerCallbackQuery(query.id, 'Этот вопрос уже закрыт.');
      return;
    }

    if (parsed.kind === 'question') {
      const option = pending.options[parsed.index];
      if (!option) {
        await telegram.answerCallbackQuery(query.id, 'Такого варианта нет.');
        return;
      }
      await telegram.answerCallbackQuery(query.id, `Выбрано: ${option.text}`);
      await resolveQuestion(pending, option.value, { chatId, messageId, via: 'button' });
      return;
    }

    if (parsed.decision === 'cancel') {
      await telegram.answerCallbackQuery(query.id, 'Отменено.');
      await store.closePending(pending.id, { status: 'cancelled', chatId });
      await store.appendJournal({ direction: 'in', type: 'action', name: pending.action?.name || '', cancelled: true, chatId });
      await telegram.editMessageText(chatId, messageId, `❌ <b>Отменено</b>\n\n${pending.title}`).catch(() => {});
      return;
    }

    await telegram.answerCallbackQuery(query.id, 'Выполняю…');
    try {
      const result = await actions.run(pending.action.name, pending.action.payload);
      await store.closePending(pending.id, { status: 'done', result, chatId });
      await store.appendJournal({ direction: 'out', type: 'action', name: pending.action.name, payload: pending.action.payload, result, chatId });
      await telegram.editMessageText(chatId, messageId, `✅ <b>Выполнено</b>\n\n${pending.title}\n\n${result}`).catch(() => {});
    } catch (error) {
      await store.closePending(pending.id, { status: 'failed', error: error.message, chatId });
      await store.appendJournal({ direction: 'out', type: 'action', name: pending.action.name, payload: pending.action.payload, error: error.message, chatId });
      await telegram.editMessageText(chatId, messageId, `🔥 <b>Не удалось выполнить</b>\n\n${pending.title}\n\n${error.message}`).catch(() => {});
    }
  }

  async function handleMessage(message) {
    const chatId = String(message.chat?.id);
    if (!isAllowedChat(config, chatId)) {
      logger.warn(`Сообщение из неразрешённого чата ${chatId} проигнорировано.`);
      return;
    }
    const text = (message.text || '').trim();
    if (!text) return;
    if (text.startsWith('/')) {
      await handleCommand(chatId, text);
      return;
    }
    const openQuestions = (await store.listPending()).filter((entry) => entry.kind === 'question');
    if (openQuestions.length === 1) {
      await resolveQuestion(openQuestions[0], text, { chatId, via: 'text' });
      await reply(chatId, `Записал ответ: <b>${text}</b>`);
      return;
    }
    await store.appendJournal({ direction: 'in', type: 'message', chatId, text });
    if (openQuestions.length > 1) {
      await reply(chatId, 'Открыто несколько вопросов — ответьте кнопкой в нужном сообщении.');
      return;
    }
    await reply(chatId, 'Записал сообщение в журнал. Команды: /status, /pending, /last');
  }

  async function handleUpdate(update) {
    if (update.callback_query) return handleCallback(update.callback_query);
    if (update.message) return handleMessage(update.message);
    return undefined;
  }

  return {
    handleUpdate,
    async pollOnce() {
      const updates = await telegram.getUpdates(offset + 1, config.pollTimeoutSeconds);
      for (const update of updates || []) {
        offset = Math.max(offset, update.update_id);
        try {
          await handleUpdate(update);
        } catch (error) {
          logger.error(`Ошибка обработки обновления ${update.update_id}: ${error.message}`);
        }
      }
      return (updates || []).length;
    },
    async start() {
      stopped = false;
      await telegram.setMyCommands([
        { command: 'status', description: 'Состояние оповещений' },
        { command: 'pending', description: 'Что ждёт ответа' },
        { command: 'last', description: 'Последние события' },
        { command: 'help', description: 'Справка' }
      ]).catch(() => {});
      while (!stopped) {
        try {
          await this.pollOnce();
        } catch (error) {
          logger.error(`Опрос Telegram не удался: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    },
    stop() {
      stopped = true;
    }
  };
}
