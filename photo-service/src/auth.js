import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const MAX_SESSION_AGE_SECONDS = 8 * 60 * 60;

export function normalizeLogin(login) {
  if (typeof login !== 'string') return '';
  return login.trim().toLowerCase();
}

// Backwards-compatible name for older API clients that still send `email`.
export function normalizeEmail(email) {
  return normalizeLogin(email);
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('password must contain at least 12 characters');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', 32768, 8, 1, salt.toString('base64url'), Buffer.from(derived).toString('base64url')].join('$');
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const [algorithm, nText, rText, pText, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'scrypt' || !/^\d+$/.test(nText) || !/^\d+$/.test(rText) || !/^\d+$/.test(pText)) return false;
  try {
    const expected = Buffer.from(hashText, 'base64url');
    if (expected.length !== KEY_LENGTH || Number(nText) !== 32768 || Number(rText) !== 8 || Number(pText) !== 1) return false;
    const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, {
      N: Number(nText), r: Number(rText), p: Number(pText), maxmem: 64 * 1024 * 1024,
    }));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    // Clipboard порезал значение или в него попал знак процента: разборка
    // сессии не должна валить запрос пятисоткой, поэтому такая пара просто
    // читается как есть, а не проходит через decodeURIComponent.
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

// Browsers silently drop a SameSite=None cookie without Secure, so the two attributes travel together.
function cookieScope({ path = '/photo-api', secure = true, sameSite = 'Lax' } = {}) {
  const attributes = [`Path=${path || '/'}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (secure || sameSite === 'None') attributes.push('Secure');
  return attributes;
}

export function sessionCookie(token, options = {}) {
  const attributes = [`photo_session=${encodeURIComponent(token)}`, ...cookieScope(options)];
  attributes.push(`Max-Age=${MAX_SESSION_AGE_SECONDS}`);
  return attributes.join('; ');
}

export function expiredSessionCookie(options = {}) {
  return ['photo_session=', ...cookieScope(options), 'Max-Age=0'].join('; ');
}

// Fallback for browsers that block third-party cookies: the atlas is served from a
// different origin than the photo service, so the session can also arrive as a bearer token.
export function bearerToken(header) {
  if (typeof header !== 'string') return '';
  const match = /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

export { MAX_SESSION_AGE_SECONDS };
