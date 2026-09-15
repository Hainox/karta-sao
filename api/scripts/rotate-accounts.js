// Выдача доступов к рабочему контуру карты ОДХ.
//
// Контур состоит из двух ролей: район готовит и отправляет набор правок
// (district_editor), префектура принимает решение (reviewer, prefecture_admin).
// Без учётной записи приёмки отправленный набор утвердить некому, поэтому скрипт
// создаёт её вместе с районами и печатает таблицу доступов.
//
//   node scripts/rotate-accounts.js                 # таблица в stdout
//   node scripts/rotate-accounts.js --verify https://obhod-sao.ru/odh-api
//
// Пароли печатаются только в stdout: не сохраняйте вывод в репозитории.
import { randomInt, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from '../lib/auth.js';
import { databasePoolOptions } from '../lib/database-config.js';
import { createRepository, migrate } from '../lib/repository.js';
import { DISTRICTS } from '../lib/validation.js';

// Без похожих символов: 0/O, 1/l/I исключены, чтобы пароль можно было продиктовать.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function randomPassword() {
  const groups = [];
  for (let group = 0; group < 4; group += 1) {
    let chunk = '';
    for (let index = 0; index < 4; index += 1) chunk += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(chunk);
  }
  return groups.join('-');
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`--${name} требует значение`);
    process.exit(2);
  }
  return value;
}

const prefectureLogin = (process.env.ODH_PREFECTURE_LOGIN || 'префектура').toLowerCase();
const verifyUrl = (argument('verify') || '').replace(/\/+$/, '');

const accounts = [...DISTRICTS]
  .sort((first, second) => first.localeCompare(second, 'ru'))
  .map((district) => ({ email: district.toLowerCase(), role: 'district_editor', district }))
  .concat([{ email: prefectureLogin, role: 'prefecture_admin', district: null }]);

const pool = new Pool(databasePoolOptions());
try {
  await migrate(pool);
  const repository = createRepository(pool);
  const rows = [];

  for (const account of accounts) {
    const password = randomPassword();
    const passwordHash = await hashPassword(password);
    const existing = await repository.findUserByEmail(account.email);
    if (existing) {
      await pool.query('UPDATE users SET password_hash = $2, role = $3, district = $4 WHERE id = $1', [existing.id, passwordHash, account.role, account.district]);
    } else {
      await pool.query('INSERT INTO users (id, email, password_hash, role, district) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), account.email, passwordHash, account.role, account.district]);
    }

    let verified = '';
    if (verifyUrl) {
      try {
        const response = await fetch(`${verifyUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: account.email, password })
        });
        const body = await response.json().catch(() => null);
        verified = response.ok && body?.user?.email === account.email ? 'да' : 'НЕТ';
      } catch {
        verified = 'НЕТ';
      }
    }
    rows.push({ ...account, password, verified });
  }

  console.log('роль;район;логин;пароль;вход проверен');
  for (const row of rows) {
    console.log([row.role === 'district_editor' ? 'Район' : 'Префектура', row.district || 'весь САО', row.email, row.password, row.verified].join(';'));
  }
  const failed = rows.filter((row) => row.verified === 'НЕТ').length;
  console.error(`учётных записей выдано: ${rows.length}${verifyUrl ? `, не подтвердили вход: ${failed}` : ''}`);
} finally {
  await pool.end();
}
