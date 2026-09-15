// Меняет пароль существующей учётки. Пароль вводится скрыто и в аргументах не передаётся.
//
//   node scripts/set-password.js --login "Аэропорт"
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { hashPassword, normalizeLogin } from '../src/auth.js';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readHidden(prompt) {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write('\n');
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return new Promise((resolve) => {
    let value = '';
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      if (text === '\r' || text === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (text === '\u0003') {
        process.exit(130);
      } else if (text === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += text;
      }
    };
    stdin.on('data', onData);
  });
}

const login = normalizeLogin(option('login'));
if (!login) {
  console.error('Usage: node scripts/set-password.js --login LOGIN');
  process.exit(2);
}

const password = await readHidden('New password (12+ chars, input hidden): ');
if (password.length < 12) {
  console.error('Password must contain at least 12 characters');
  process.exit(2);
}

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
try {
  const hash = await hashPassword(password);
  const result = await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE email = $1 RETURNING id', [login, hash]);
  if (!result.rowCount) {
    console.error('No account with this login');
    process.exitCode = 1;
  } else {
    // Существующие сессии отзываются: старый пароль больше не должен работать нигде.
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [result.rows[0].id]);
    console.log(`Password updated for ${login}, active sessions dropped`);
  }
} finally {
  await pool.end();
}
