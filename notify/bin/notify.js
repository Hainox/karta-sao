#!/usr/bin/env node
// Отправка уведомлений, вопросы и подтверждения действий из командной строки.
//
//   node bin/notify.js event --kind agent --title "Аудит завершён" --text "5 исправлений"
//   node bin/notify.js ask --text "Перезапускать сервис?" --option "Да=yes" --option "Нет=no" --wait
//   node bin/notify.js action --name submission.approve --title "Утвердить набор" --submission <uuid> --wait
//
// Работает через сервис оповещений (NOTIFY_URL) или напрямую через Telegram (TELEGRAM_BOT_TOKEN).
import { pathToFileURL } from 'node:url';

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const flags = { option: [], field: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[index + 1];
    const value = next === undefined || next.startsWith('--') ? true : next;
    if (value !== true) index += 1;
    if (name === 'option' || name === 'field') flags[name].push(value);
    else flags[name] = value;
  }
  return { command, flags };
}

function fieldsFrom(list) {
  const fields = {};
  for (const item of list) {
    const separator = String(item).indexOf('=');
    if (separator < 0) fields[item] = true;
    else fields[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return fields;
}

async function callService(base, secret, path, payload) {
  const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Notify-Secret': secret } : {}) },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

async function waitForAnswer(base, secret, id, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base.replace(/\/+$/, '')}/pending/${id}`, {
      headers: secret ? { 'X-Notify-Secret': secret } : {}
    });
    const body = await response.json().catch(() => null);
    if (body?.pending && body.pending.status !== 'open') return body.pending;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

async function sendDirect(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = (env.TELEGRAM_CHAT_IDS || env.TELEGRAM_CHAT_ID || '').split(',')[0]?.trim();
  if (!token || !chatId) throw new Error('Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_IDS.');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(`Telegram: ${body?.description || response.status}`);
  return body.result;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, flags } = parseArguments(argv);
  const service = env.NOTIFY_URL;
  const secret = env.NOTIFY_SECRET;

  if (!command || command === 'help' || flags.help) {
    console.log('Команды: event, ask, action, status');
    return 0;
  }

  if (command === 'event') {
    const event = {
      kind: flags.kind || 'agent',
      level: flags.level || 'info',
      service: flags.service || 'agent',
      title: flags.title || 'Без заголовка',
      text: flags.text || '',
      fields: fieldsFrom(flags.field)
    };
    if (service) {
      const result = await callService(service, secret, '/event', event);
      console.log(`Отправлено в ${result.delivered} чат(а).`);
      return 0;
    }
    const message = [event.title, event.text].filter(Boolean).join('\n');
    await sendDirect(env, message);
    console.log('Отправлено напрямую через Telegram.');
    return 0;
  }

  if (command === 'ask' || command === 'action') {
    if (!service) throw new Error('Для вопросов нужен NOTIFY_URL — сервис оповещений ведёт учёт ответов.');
    const payload = command === 'ask'
      ? {
        question: flags.text || flags.question,
        details: flags.details,
        options: flags.option.length ? flags.option.map((item) => {
          const separator = String(item).indexOf('=');
          return separator < 0 ? { text: item, value: item } : { text: item.slice(0, separator), value: item.slice(separator + 1) };
        }) : [{ text: 'Да', value: 'yes' }, { text: 'Нет', value: 'no' }],
        timeoutSeconds: flags.timeout ? Number(flags.timeout) : undefined
      }
      : {
        name: flags.name,
        title: flags.title,
        details: flags.details,
        confirmText: flags.confirm,
        payload: { ...fieldsFrom(flags.field), submissionId: flags.submission, district: flags.district },
        timeoutSeconds: flags.timeout ? Number(flags.timeout) : undefined
      };
    const result = await callService(service, secret, command === 'ask' ? '/ask' : '/action', payload);
    console.log(`Отправлено в ${result.delivered} чат(а), номер ${result.id}.`);
    if (!flags.wait) return 0;

    const pending = await waitForAnswer(service, secret, result.id, Number(flags.timeout || 900));
    if (!pending) {
      console.log('Ответа не дождались.');
      return 2;
    }
    if (pending.status === 'answered') {
      console.log(`Ответ: ${pending.resolution?.answer}`);
      return 0;
    }
    console.log(`Решение: ${pending.status}${pending.resolution?.result ? ` · ${pending.resolution.result}` : ''}`);
    return pending.status === 'done' ? 0 : 1;
  }

  if (command === 'status') {
    if (!service) throw new Error('Для состояния нужен NOTIFY_URL.');
    const response = await fetch(`${service.replace(/\/+$/, '')}/health`);
    const health = await response.json();
    const pendingResponse = await fetch(`${service.replace(/\/+$/, '')}/pending`, { headers: secret ? { 'X-Notify-Secret': secret } : {} });
    const pending = await pendingResponse.json();
    console.log(`Сервис: ${health.ok ? 'работает' : 'недоступен'}, открытых запросов: ${pending.pending?.length ?? 0}`);
    return 0;
  }

  throw new Error(`Неизвестная команда «${command}».`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    process.exit(1);
  });
}
