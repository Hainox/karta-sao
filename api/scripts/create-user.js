import { Pool } from 'pg';
import { hashPassword } from '../lib/auth.js';
import { createRepository, migrate } from '../lib/repository.js';
import { DISTRICTS } from '../lib/validation.js';

const options = Object.fromEntries(process.argv.slice(2).map((value, index, array) => value.startsWith('--') ? [value.slice(2), array[index + 1]] : null).filter(Boolean));
const { email, password, role, district } = options;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан.');
if (!email || !password || !['district_editor', 'reviewer', 'prefecture_admin'].includes(role)) throw new Error('Используйте --email --password --role. Роль: district_editor, reviewer или prefecture_admin.');
if (role === 'district_editor' && !district) throw new Error('Для district_editor обязательно укажите --district.');
if (district && !DISTRICTS.has(district)) throw new Error('Неизвестный район САО.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool);
  const user = await createRepository(pool).createUser({ email, passwordHash: await hashPassword(password), role, district: district || null });
  console.log(`Создан пользователь ${user.email} с ролью ${user.role}.`);
} finally { await pool.end(); }
