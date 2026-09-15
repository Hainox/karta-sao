import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createTelegram } from './telegram.js';
import { createActions } from './actions.js';
import { createNotifier } from './notifier.js';
import { createBot } from './bot.js';
import { createHttpServer } from './http.js';

export async function startServer({ env = process.env, logger = console } = {}) {
  const config = loadConfig(env);
  const store = createStore({ dir: config.dataDir, journalLimit: config.journalLimit });
  await store.init();

  const telegram = createTelegram({ token: config.token });
  const actions = createActions({ config });
  const notifier = createNotifier({ config, telegram, store });
  const bot = createBot({ config, telegram, store, notifier, actions, logger });
  const server = createHttpServer({ config, notifier, store });

  await new Promise((resolve) => server.listen(config.port, '0.0.0.0', resolve));
  logger.log(`Приём событий слушает порт ${config.port}. Разрешённые чаты: ${config.allowedChatIds.join(', ')}.`);

  bot.start().catch((error) => logger.error(`Опрос Telegram остановлен: ${error.message}`));

  const shutdown = () => {
    bot.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { config, store, bot, server, notifier, actions };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  startServer().catch((error) => {
    console.error(`Не удалось запустить оповещения: ${error.message}`);
    process.exit(1);
  });
}
