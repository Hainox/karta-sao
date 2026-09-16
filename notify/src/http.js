import { createServer } from 'node:http';

const MAX_BODY = 64 * 1024;
// Картинка сводки приходит в base64 и весит больше обычного события.
const MAX_PHOTO_BODY = 8 * 1024 * 1024;

async function readBody(request, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Слишком большое тело запроса.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Тело запроса не является корректным JSON.'), { status: 400 });
  }
}

function isLocal(request) {
  const address = request.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createHttpServer({ config, notifier, store }) {
  const authorize = (request, response) => {
    if (config.secret) {
      if (request.headers['x-notify-secret'] === config.secret) return true;
      response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Неверный секрет.' }));
      return false;
    }
    if (isLocal(request)) return true;
    response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Задайте NOTIFY_SECRET: без него принимаются только локальные запросы.' }));
    return false;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, body) => response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        const pending = await store.listPending();
        return send(200, { ok: true, open: pending.length });
      }

      if (!authorize(request, response)) return undefined;

      if (request.method === 'GET' && url.pathname === '/journal') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 30), config.journalLimit);
        return send(200, { entries: await store.readJournal(limit) });
      }

      if (request.method === 'GET' && url.pathname === '/pending') {
        return send(200, { pending: await store.listPending() });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/pending/')) {
        const entry = await store.getPending(url.pathname.slice('/pending/'.length));
        return entry ? send(200, { pending: entry }) : send(404, { error: 'Не найдено.' });
      }

      if (request.method === 'POST' && url.pathname === '/event') {
        const body = await readBody(request);
        if (!body.title && !body.text) return send(400, { error: 'Нужны title или text.' });
        const result = await notifier.publish(body);
        return send(202, { delivered: result.delivered.length, id: result.record.id });
      }

      if (request.method === 'POST' && url.pathname === '/photo') {
        const body = await readBody(request, MAX_PHOTO_BODY);
        if (!body.photo) return send(400, { error: 'Нужна картинка в поле photo (base64).' });
        const result = await notifier.photo(body);
        return send(202, { delivered: result.delivered.length });
      }

      if (request.method === 'POST' && url.pathname === '/ask') {
        const body = await readBody(request);
        const result = await notifier.ask(body);
        return send(202, { id: result.pending.id, delivered: result.delivered.length });
      }

      if (request.method === 'POST' && url.pathname === '/action') {
        const body = await readBody(request);
        const result = await notifier.requestAction(body);
        return send(202, { id: result.pending.id, delivered: result.delivered.length });
      }

      return send(404, { error: 'Неизвестный маршрут.' });
    } catch (error) {
      return send(error.status || 500, { error: error.message });
    }
  });

  return server;
}
