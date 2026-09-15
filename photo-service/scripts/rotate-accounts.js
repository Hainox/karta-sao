// Массовая замена паролей и выгрузка файла учёток.
//
// Нужна, когда пароли могли утечь: например, если они попали в репозиторий или
// в переписку. Скрипт задаёт каждому найденному аккаунту новый случайный пароль,
// проверяет вход через публичный API и складывает таблицу в xlsx.
//
//   node scripts/rotate-accounts.js --out /out/accounts.xlsx
//
// Пароли печатаются только в файл: скрипт намеренно не выводит их в консоль.
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { randomInt } from 'node:crypto';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { hashPassword } from '../src/auth.js';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

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

const out = option('--out');
const publicUrl = (option('--public-url', process.env.PHOTO_SERVICE_PUBLIC_URL || 'https://obhod-sao.ru/photo-api')).replace(/\/$/, '');

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
let rotated = 0;
let verified = 0;
try {
  const result = await pool.query(
    `SELECT email, display_name, role, district FROM users WHERE active = true ORDER BY role, district NULLS LAST, email`,
  );
  if (!result.rowCount) throw new Error('нет активных учёток');

  const rows = [];
  for (const user of result.rows) {
    const password = randomPassword();
    await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE email = $1', [user.email, await hashPassword(password)]);
    await pool.query('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)', [user.email]);
    rotated += 1;

    // Проверяем ровно то, чем будет пользоваться район: вход через публичный адрес.
    let ok = false;
    try {
      const response = await fetch(`${publicUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: user.email, password }),
      });
      const body = await response.json().catch(() => null);
      ok = response.ok && body?.user?.email === user.email;
    } catch {
      ok = false;
    }
    if (ok) verified += 1;
    rows.push({ user, password, ok });
  }

  if (out) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Фотослужба САО';
    const sheet = workbook.addWorksheet('Учётные записи');
    sheet.columns = [
      { header: 'Район', key: 'district', width: 26 },
      { header: 'Логин', key: 'login', width: 26 },
      { header: 'Пароль', key: 'password', width: 22 },
      { header: 'Роль', key: 'role', width: 14 },
      { header: 'Доступ', key: 'scope', width: 68 },
      { header: 'Вход проверен', key: 'checked', width: 16 },
    ];
    for (const { user, password, ok } of rows) {
      const districtRole = user.role === 'district_editor';
      sheet.addRow({
        district: user.district || user.display_name,
        login: user.email,
        password,
        role: districtRole ? 'Район' : 'Префектура',
        scope: districtRole
          ? 'Только свой район: снимает и отправляет фото. Выгрузок нет.'
          : 'Весь САО: сводка, разбор фиксаций, выгрузки Excel и PDF.',
        checked: ok ? 'да' : 'НЕТ',
      });
    }
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: 'F1' };

    const info = workbook.addWorksheet('Как войти');
    info.columns = [{ width: 100 }];
    for (const line of [
      'Фотофиксация объектов САО',
      '',
      'Адрес: https://hainox.github.io/karta-sao/hub/',
      'На странице атласа открыть карточку «Фотофиксация объектов САО».',
      '',
      'Как работает район:',
      '1. Открыть адрес и войти: логин — название района, пароль со вкладки «Учётные записи».',
      '2. На карте видно только свой район и его границу.',
      '3. Открыть объект, добавить фото, нажать «Определить GPS» и разрешить доступ.',
      '4. Показанное расстояние подскажет, попали ли вы в радиус вокруг объекта.',
      '5. Указать исполнителя и отправить. Подтверждение делает префектура.',
      '6. На телефоне список и фильтры открываются кнопкой «Список и фильтры» поверх карты.',
      '',
      'ВНИМАНИЕ: файл содержит пароли. Не пересылайте его в общие чаты, не храните в репозитории',
      'и удалите после того, как раздадите доступы. Сменить пароль: node scripts/set-password.js --login "<логин>".',
    ]) {
      const row = info.addRow([line]);
      if (line.startsWith('ВНИМАНИЕ') || line.startsWith('Фотофиксация')) row.font = { bold: true };
    }
    await workbook.xlsx.writeFile(out);
  }

  console.log(`паролей заменено: ${rotated}`);
  console.log(`вход проверен успешно: ${verified} из ${rotated}`);
  if (out) console.log(`файл учёток: ${out}`);
  if (verified !== rotated) process.exitCode = 1;
} finally {
  await pool.end();
}
