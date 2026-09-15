export function createActions({ config, fetchImpl = fetch }) {
  let cachedToken = null;

  async function login(service) {
    const credentials = service === 'photo'
      ? { url: config.photoService.apiUrl, login: config.photoService.login, password: config.photoService.password }
      : { url: config.odh.apiUrl, login: config.odh.login, password: config.odh.password };
    if (!credentials.url || !credentials.login || !credentials.password) {
      throw new Error('Доступы к API не настроены: задайте адрес и учётную запись префектуры.');
    }
    if (cachedToken && cachedToken.service === service && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken;

    const response = await fetchImpl(`${credentials.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: credentials.login, password: credentials.password })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.token) throw new Error(`Не удалось войти в API: ${body?.error || `HTTP ${response.status}`}`);
    cachedToken = { service, token: body.token, expiresAt: Date.now() + 3600_000 };
    return cachedToken;
  }

  async function reviewSubmission(payload, status, comment) {
    const { token } = await login(payload.service === 'photo' ? 'photo' : 'odh');
    const base = payload.service === 'photo' ? config.photoService.apiUrl : config.odh.apiUrl;
    const response = await fetchImpl(`${base}/api/submissions/${payload.submissionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status, comment })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `API ответил HTTP ${response.status}`);
    return { status: body?.submission?.status || status, district: payload.district || body?.submission?.district || '' };
  }

  const registry = {
    'submission.approve': {
      service: 'odh',
      title: 'Утвердить набор правок района',
      async run(payload) {
        const result = await reviewSubmission(payload, 'approved', payload.comment || 'Утверждено из Telegram');
        return `Набор утверждён${result.district ? ` · ${result.district}` : ''}.`;
      }
    },
    'submission.reject': {
      service: 'odh',
      title: 'Отклонить набор правок района',
      async run(payload) {
        const result = await reviewSubmission(payload, 'rejected', payload.comment || 'Отклонено из Telegram');
        return `Набор отклонён${result.district ? ` · ${result.district}` : ''}.`;
      }
    }
  };

  return {
    names: () => Object.keys(registry),
    describe: (name) => registry[name]?.title || null,
    has: (name) => Boolean(registry[name]),
    async run(name, payload = {}) {
      const action = registry[name];
      if (!action) throw new Error(`Действие «${name}» не разрешено.`);
      return action.run(payload);
    }
  };
}
