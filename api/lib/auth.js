import crypto from 'node:crypto';

const base64url = (value) => Buffer.from(value).toString('base64url');
const unbase64url = (value) => Buffer.from(value, 'base64url').toString('utf8');

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Пароль должен содержать минимум 8 символов.');
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash || '').split(':');
  if (!salt || !expected) return false;
  const derived = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
  const actual = Buffer.from(derived).toString('hex');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function signToken(user, secret, ttlSeconds = 8 * 60 * 60) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: user.id, role: user.role, district: user.district, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const body = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyToken(token, secret) {
  const [header, payload, signature] = String(token || '').split('.');
  if (!header || !payload || !signature) throw new Error('Токен отсутствует или повреждён.');
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new Error('Подпись токена неверна.');
  const decoded = JSON.parse(unbase64url(payload));
  if (!decoded.exp || decoded.exp <= Math.floor(Date.now() / 1000)) throw new Error('Сеанс истёк.');
  return decoded;
}
