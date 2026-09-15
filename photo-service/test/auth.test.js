import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, hashSessionToken, normalizeLogin, parseCookies, sessionCookie, verifyPassword } from '../src/auth.js';

test('district names are accepted as normalized logins', () => {
  assert.equal(normalizeLogin('  Аэропорт '), 'аэропорт');
  assert.equal(normalizeLogin(''), '');
  assert.equal(normalizeLogin(null), '');
});

test('passwords use a salted scrypt encoding and verify without exposing the password', async () => {
  const encoded = await hashPassword('long-enough-test-password');
  assert.match(encoded, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('long-enough-test-password', encoded), true);
  assert.equal(await verifyPassword('wrong-password', encoded), false);
  assert.notEqual(encoded, await hashPassword('long-enough-test-password'));
});

test('rejects weak account passwords', async () => {
  await assert.rejects(() => hashPassword('too-short'), /12 characters/);
});

test('session cookies are httpOnly, scoped, and secure by default', () => {
  const cookie = sessionCookie('opaque-token');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/photo-api/);
  assert.equal(parseCookies(cookie).photo_session, 'opaque-token');
  assert.equal(hashSessionToken('opaque-token').length, 64);
});
