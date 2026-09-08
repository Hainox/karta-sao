/* Optional API connection for a separately hosted ODH exchange service. */
(function () {
  'use strict';
  const BASE_KEY = 'odh-map-api-base-v1';
  const TOKEN_KEY = 'odh-map-api-token-v1';
  const USER_KEY = 'odh-map-api-user-v1';
  const normaliseBase = (value) => String(value || '').trim().replace(/\/+$/, '');
  function base() { return normaliseBase(localStorage.getItem(BASE_KEY)); }
  function setBase(value) { const next = normaliseBase(value); if (next) localStorage.setItem(BASE_KEY, next); else localStorage.removeItem(BASE_KEY); return next; }
  function user() { try { return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; } }
  function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
  function clearSession() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(USER_KEY); }
  async function request(path, options = {}) {
    if (!base()) throw new Error('Укажите адрес API. На GitHub Pages сервер базы данных не запускается.');
    const headers = new Headers(options.headers || {}); headers.set('Accept', 'application/json');
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (token()) headers.set('Authorization', `Bearer ${token()}`);
    const response = await fetch(`${base()}${path}`, { ...options, headers });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `API вернул HTTP ${response.status}.`); }
    return response;
  }
  async function login(email, password) {
    const response = await request('/api/auth/login', { method:'POST', body:JSON.stringify({ email, password }) });
    const data = await response.json(); sessionStorage.setItem(TOKEN_KEY, data.token); sessionStorage.setItem(USER_KEY, JSON.stringify(data.user)); return data.user;
  }
  window.ODHApi = { base, setBase, user, token, clearSession, request, login };
}());
