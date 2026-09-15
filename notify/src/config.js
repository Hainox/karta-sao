const value = (name, env) => String(env[name] ?? '').trim();

function required(name, env) {
  const result = value(name, env);
  if (!result) throw new Error(`Не задана переменная окружения ${name}.`);
  return result;
}

function chatIds(raw) {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const token = required('TELEGRAM_BOT_TOKEN', env);
  const allowed = chatIds(value('TELEGRAM_CHAT_IDS', env) || value('TELEGRAM_CHAT_ID', env));
  if (!allowed.length) throw new Error('Не задан TELEGRAM_CHAT_IDS — кому боту разрешено писать и отвечать.');
  return {
    token,
    allowedChatIds: allowed,
    dataDir: value('NOTIFY_DATA_DIR', env) || './data',
    port: Number(value('NOTIFY_PORT', env) || 8790),
    secret: value('NOTIFY_SECRET', env),
    pollTimeoutSeconds: Number(value('NOTIFY_POLL_TIMEOUT', env) || 25),
    answerTimeoutSeconds: Number(value('NOTIFY_ANSWER_TIMEOUT', env) || 3600),
    journalLimit: Number(value('NOTIFY_JOURNAL_LIMIT', env) || 500),
    odh: {
      apiUrl: value('ODH_API_URL', env).replace(/\/+$/, ''),
      login: value('ODH_PREFECTURE_LOGIN', env),
      password: value('ODH_PREFECTURE_PASSWORD', env)
    },
    photoService: {
      apiUrl: value('PHOTO_SERVICE_API_URL', env).replace(/\/+$/, ''),
      login: value('PHOTO_SERVICE_PREFECTURE_LOGIN', env),
      password: value('PHOTO_SERVICE_PREFECTURE_PASSWORD', env)
    }
  };
}

export function isAllowedChat(config, chatId) {
  return config.allowedChatIds.includes(String(chatId));
}
