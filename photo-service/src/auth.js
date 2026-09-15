import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const MAX_SESSION_AGE_SECONDS = 8 * 60 * 60;

export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
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
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function sessionCookie(token, { secure = true, path = '/photo-api' } = {}) {
  const attributes = [
    `photo_session=${encodeURIComponent(token)}`,
    `Path=${path || '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_SESSION_AGE_SECONDS}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function expiredSessionCookie(path = '/photo-api') {
  return `photo_session=; Path=${path || '/'}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { MAX_SESSION_AGE_SECONDS };
