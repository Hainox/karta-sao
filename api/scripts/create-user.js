import { Pool } from 'pg';
import { hashPassword } from '../lib/auth.js';
import { databasePoolOptions } from '../lib/database-config.js';
import { readHiddenInput } from '../lib/hidden-input.js';
import { createRepository, migrate } from '../lib/repository.js';
import { DISTRICTS } from '../lib/validation.js';

const args = process.argv.slice(2);
if (args.includes('--password')) throw new Error('Пароль вводится в скрытом приглашении, а не через аргумент командной строки.');
const options = Object.fromEntries(args.map((value, index, values) => value.startsWith('--') ? [value.slice(2), values[index + 1]] : null).filter(Boolean));
const { email, role, district } = options;
const poolOptions = databasePoolOptions();
if (!email || !['district_editor', 'prefecture_admin'].includes(role)) throw new Error('Используйте --email и --role. Роль: district_editor или prefecture_admin.');
if (role === 'district_editor' && !district) throw new Error('Для district_editor обязательно укажите --district.');
if (district && !DISTRICTS.has(district)) throw new Error('Неизвестный район САО.');
const password = await readHiddenInput('Пароль: ');
if (password !== await readHiddenInput('Повторите пароль: ')) throw new Error('Введённые пароли не совпадают.');
const pool = new Pool(poolOptions);
try {
  await migrate(pool);
  const user = await createRepository(pool).createUser({ email, passwordHash: await hashPassword(password), role, district: district || null });
  console.log(`Создан пользователь ${user.email} с ролью ${user.role}.`);
} finally { await pool.end(); }
