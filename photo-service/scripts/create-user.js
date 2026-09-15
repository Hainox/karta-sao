import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { hashPassword, normalizeEmail } from '../src/auth.js';

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

const email = normalizeEmail(option('email'));
const displayName = option('display-name');
const role = option('role');
const district = option('district') || null;
if (!email || !displayName || !['district_editor', 'prefecture_admin'].includes(role)
  || (role === 'district_editor' && !district) || (role === 'prefecture_admin' && district)) {
  console.error('Usage: node scripts/create-user.js --email EMAIL --display-name NAME --role district_editor|prefecture_admin [--district DISTRICT]');
  process.exit(2);
}
const password = await readHidden('Password (12+ chars, input hidden): ');
if (password.length < 12) {
  console.error('Password must contain at least 12 characters');
  process.exit(2);
}

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
try {
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (id, email, display_name, role, district, password_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), email, displayName.trim(), role, district?.trim() || null, hash],
  );
  console.log(`Created ${role} account ${email}`);
} catch (error) {
  if (error.code === '23505') {
    console.error('An account with this email already exists');
    process.exitCode = 1;
  } else throw error;
} finally {
  await pool.end();
}
