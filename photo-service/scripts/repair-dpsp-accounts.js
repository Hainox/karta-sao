// Починка районных учёток кабинета ДП/СП.
//
// Вход — таблица без заголовка: логин, район, пароль через табуляцию или
// точку с запятой. Пароли читаются из файла, в аргументах командной строки их
// нет, в вывод не попадают.
//
// По умолчанию скрипт только показывает, что изменится. С --apply он создаёт
// отсутствующие учётки и приводит роль, район, активность и пароль к выданным
// значениям; сессии исправленных учёток закрываются. Учётки, которые уже
// работают с этим паролем, не меняются.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { hashPassword, normalizeLogin, verifyPassword } from '../src/auth.js';
import { DPSP_EDITOR, dpspDistrict } from '../src/tpu-points/dpsp-access.js';

const MIN_PASSWORD = 12;

export function parseAccounts(text) {
  const entries = [];
  const problems = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const [login, district, password] = line.split(/[\t;]/).map(value => (value ?? '').trim());
    const canonical = dpspDistrict(district);
    if (!login || !district || !password) {
      problems.push(`строка ${index + 1}: нужны логин, район и пароль через табуляцию или точку с запятой`);
      return;
    }
    if (!canonical) {
      problems.push(`строка ${index + 1}: «${district}» не район САО`);
      return;
    }
    if (password.length < MIN_PASSWORD) {
      problems.push(`строка ${index + 1}: пароль короче ${MIN_PASSWORD} символов`);
      return;
    }
    entries.push({ login: normalizeLogin(login), district: canonical, password,
      display_name: `ДП/СП · ${canonical}` });
  });
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.login)) problems.push(`логин ${entry.login} повторяется в файле`);
    seen.add(entry.login);
  }
  return { entries, problems };
}

export function accountChanges(current, entry, passwordOk) {
  if (!current) return ['создать'];
  const changes = [];
  if (current.role !== DPSP_EDITOR) changes.push(`роль ${current.role} → ${DPSP_EDITOR}`);
  if (current.district !== entry.district) changes.push(`район ${current.district || '—'} → ${entry.district}`);
  if (current.active !== true) changes.push('включить');
  if (!passwordOk) changes.push('сбросить пароль');
  return changes;
}

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('Использование: node scripts/repair-dpsp-accounts.js <файл.tsv> [--apply]');
    process.exit(2);
  }
  const { entries, problems } = parseAccounts(await readFile(file, 'utf8'));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(2);
  }
  if (!entries.length) {
    console.error('В файле нет учёток.');
    process.exit(2);
  }
  const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
  try {
    const report = [];
    for (const entry of entries) {
      const { rows } = await pool.query('SELECT id, role, district, active, password_hash FROM users WHERE email = $1', [entry.login]);
      const current = rows[0] || null;
      const passwordOk = current ? await verifyPassword(entry.password, current.password_hash) : false;
      report.push({ entry, current, passwordOk, changes: accountChanges(current, entry, passwordOk) });
    }
    for (const item of report) {
      const state = item.changes.length ? item.changes.join(', ') : 'без изменений';
      console.log(`${item.entry.login} · ${item.entry.district}: ${state}`);
    }
    const pending = report.filter(item => item.changes.length);
    if (!apply) {
      console.log(`Предварительный просмотр: к изменению ${pending.length} из ${report.length}. Ничего не записано.`);
      return;
    }
    for (const { entry, current, passwordOk } of pending) {
      const hash = passwordOk ? null : await hashPassword(entry.password);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO users (id, email, display_name, role, district, password_hash, active)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name,
             role = EXCLUDED.role, district = EXCLUDED.district, active = true,
             password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash)
           RETURNING id`,
          [randomUUID(), entry.login, entry.display_name, DPSP_EDITOR, entry.district,
            hash ?? current.password_hash]);
        await client.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    console.log(`Исправлено учёток: ${pending.length}. Сессии исправленных закрыты.`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
