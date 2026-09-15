export const KINDS = {
  agent: { sign: '🤖', title: 'Работа агента' },
  client: { sign: '👤', title: 'Работа пользователя' },
  question: { sign: '❓', title: 'Вопрос' },
  error: { sign: '🔥', title: 'Ошибка' },
  action: { sign: '✅', title: 'Подтверждение действия' },
  service: { sign: '🛠', title: 'Сервис' }
};

export const LEVELS = {
  info: { sign: '·', title: 'сообщение' },
  warning: { sign: '⚠️', title: 'предупреждение' },
  critical: { sign: '🚨', title: 'критично' }
};

export const CALLBACK_PREFIX = { question: 'q', action: 'a' };

export function escapeHtml(raw) {
  return String(raw ?? '').replace(/[&<>"']/g, (symbol) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[symbol]));
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map((item) => escapeHtml(item)).join(', ');
  if (value && typeof value === 'object') return escapeHtml(JSON.stringify(value));
  return escapeHtml(value);
}

export function renderEvent(event) {
  const kind = KINDS[event.kind] || KINDS.service;
  const level = LEVELS[event.level] || LEVELS.info;
  const header = `${kind.sign} <b>${kind.title}</b> · ${level.sign} ${level.title}`;
  const lines = [header];
  if (event.title) lines.push(`<b>${escapeHtml(event.title)}</b>`);
  if (event.text) lines.push(escapeHtml(event.text));
  const fields = Object.entries(event.fields || {}).filter(([, item]) => item !== undefined && item !== null && item !== '');
  if (fields.length) {
    lines.push(fields.map(([name, item]) => `• ${escapeHtml(name)}: ${formatValue(item)}`).join('\n'));
  }
  if (event.service) lines.push(`<i>Источник: ${escapeHtml(event.service)}</i>`);
  return lines.join('\n\n');
}

export function renderQuestion(pending) {
  const lines = ['❓ <b>Вопрос</b>', escapeHtml(pending.question)];
  if (pending.details) lines.push(escapeHtml(pending.details));
  lines.push('Выберите вариант кнопкой ниже или ответьте сообщением.');
  return lines.join('\n\n');
}

export function renderAction(pending) {
  const lines = ['✅ <b>Нужно подтверждение</b>', escapeHtml(pending.title)];
  if (pending.details) lines.push(escapeHtml(pending.details));
  lines.push('Нажмите кнопку. Действие выполняется только после подтверждения.');
  return lines.join('\n\n');
}

export function keyboardFor(pending) {
  if (pending.kind === 'question') {
    return {
      inline_keyboard: pending.options.map((option, index) => [
        { text: option.text, callback_data: `${CALLBACK_PREFIX.question}:${pending.id}:${index}` }
      ])
    };
  }
  return {
    inline_keyboard: [[
      { text: pending.confirmText || 'Подтвердить', callback_data: `${CALLBACK_PREFIX.action}:${pending.id}:go` },
      { text: 'Отменить', callback_data: `${CALLBACK_PREFIX.action}:${pending.id}:cancel` }
    ]]
  };
}

export function parseCallback(data) {
  const [prefix, id, value] = String(data || '').split(':');
  if (prefix === CALLBACK_PREFIX.question && id && value !== undefined) return { kind: 'question', id, index: Number(value) };
  if (prefix === CALLBACK_PREFIX.action && id && value) return { kind: 'action', id, decision: value };
  return null;
}
