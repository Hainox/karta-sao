(function () {
  'use strict';
  if (['localhost', '127.0.0.1'].includes(location.hostname)) return;
  const base = 'https://obhod-sao.ru/photo-api';
  const tokenKey = 'tpu-photo-token';
  const userKey = 'tpu-photo-user';
  const user = () => { try { return JSON.parse(sessionStorage.getItem(userKey) || 'null'); } catch (_) { return null; } };
  async function request(path, options = {}) {
    const route = path === '/api/me' ? '/auth/me' : path.replace('/api/object-photo-points', '/object-photo-points');
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const token = sessionStorage.getItem(tokenKey);
    if (token) headers.set('Authorization', 'Bearer ' + token);
    const response = await fetch(base + route, { ...options, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || body.error || 'Ошибка сервиса: ' + response.status);
    }
    return response;
  }
  window.TpuPhotoApi = {
    user, request,
    clearSession() { sessionStorage.removeItem(tokenKey); sessionStorage.removeItem(userKey); },
    async login(login, password) {
      const response = await request('/auth/login', { method: 'POST', body: JSON.stringify({ login, password }) });
      const data = await response.json();
      sessionStorage.setItem(tokenKey, data.token);
      sessionStorage.setItem(userKey, JSON.stringify(data.user));
      return data.user;
    },
  };
}());
