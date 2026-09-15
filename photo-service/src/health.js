const SERVICE_NAME = 'sao-photo-service';

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export function createHealthHandler({ probeDatabase }) {
  if (typeof probeDatabase !== 'function') {
    throw new TypeError('probeDatabase must be a function');
  }

  return async (request, response) => {
    const pathname = typeof request.url === 'string'
      ? request.url.split('?', 1)[0]
      : '';

    if (request.method !== 'GET' || pathname !== '/healthz') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    try {
      await probeDatabase();
      sendJson(response, 200, {
        service: SERVICE_NAME,
        status: 'ok',
        database: 'connected',
      });
    } catch {
      sendJson(response, 503, {
        service: SERVICE_NAME,
        status: 'unavailable',
        database: 'unavailable',
      });
    }
  };
}
