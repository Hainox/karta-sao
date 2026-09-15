const REQUIRED_SETTINGS = [
  'PHOTO_SERVICE_DB_HOST',
  'PHOTO_SERVICE_DB_PORT',
  'PHOTO_SERVICE_DB_NAME',
  'PHOTO_SERVICE_DB_USER',
  'PHOTO_SERVICE_DB_PASSWORD',
];

function requiredValue(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(name + ' is required');
  }
  return value;
}

const COOKIE_SAME_SITE = Object.freeze({ lax: 'Lax', strict: 'Strict', none: 'None' });

// The atlas lives on GitHub Pages while the API lives on obhod-sao.ru, so the production
// deployment needs SameSite=None. Local development and same-origin hosting keep Lax.
export function photoServiceCookiePolicy(environment = {}) {
  const requested = String(environment.PHOTO_SERVICE_COOKIE_SAMESITE ?? '').trim().toLowerCase() || 'lax';
  const sameSite = COOKIE_SAME_SITE[requested];
  if (!sameSite) {
    throw new Error('PHOTO_SERVICE_COOKIE_SAMESITE must be one of lax, strict, none');
  }
  const path = String(environment.PHOTO_SERVICE_COOKIE_PATH ?? '').trim();
  return Object.freeze({
    path: path || '/photo-api',
    sameSite,
    secure: sameSite === 'None' ? true : environment.PHOTO_SERVICE_COOKIE_SECURE !== 'false',
  });
}

export function photoServiceDatabaseConfig(environment) {
  const settings = Object.fromEntries(
    REQUIRED_SETTINGS.map((name) => [name, requiredValue(environment, name)]),
  );
  const portText = settings.PHOTO_SERVICE_DB_PORT.trim();

  if (!/^\d+$/.test(portText)) {
    throw new Error('PHOTO_SERVICE_DB_PORT must be an integer from 1 to 65535');
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PHOTO_SERVICE_DB_PORT must be an integer from 1 to 65535');
  }

  return Object.freeze({
    host: settings.PHOTO_SERVICE_DB_HOST.trim(),
    port,
    database: settings.PHOTO_SERVICE_DB_NAME.trim(),
    user: settings.PHOTO_SERVICE_DB_USER.trim(),
    password: settings.PHOTO_SERVICE_DB_PASSWORD,
    connectionTimeoutMillis: 2500,
  });
}
