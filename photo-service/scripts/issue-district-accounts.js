// Выдача учётных записей районам и АвД САО: новые пароли и файл Excel для рассылки.
//
// Меняет пароли только районным учёткам 16 районов и АвД САО (роль district_editor).
// Префектура и отдел МКД не затрагиваются. Учётки АвД САО нет — создаёт её.
// Без --apply ничего не меняет: только показывает, кому будет выдан новый пароль.
//
//   node scripts/issue-district-accounts.js                       # просмотр
//   node scripts/issue-district-accounts.js --apply --out /out/uchetki.xlsx
//
// Пароли пишутся только в файл: в консоль скрипт их не выводит.
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { randomInt, randomUUID } from 'node:crypto';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { hashPassword, normalizeLogin } from '../src/auth.js';
import { DISTRICTS } from '../src/tpu-points/validation.js';
import { AVD_OWNER } from '../src/tpu-points/tpu-responsibility.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`--${name} requires a value`);
    process.exit(2);
  }
  return value;
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

const apply = process.argv.includes('--apply');
const out = argument('out');
if (apply && !out) {
  console.error('С --apply нужен --out: пароли сохраняются только в файл.');
  process.exit(2);
}
const publicUrl = (argument('public-url') || process.env.PHOTO_SERVICE_PUBLIC_URL || 'https://obhod-sao.ru/photo-api').replace(/\/$/, '');
const ATLAS = 'https://hainox.github.io/karta-sao';
const GROUPS = [...[...DISTRICTS].sort((a, b) => a.localeCompare(b, 'ru')), AVD_OWNER];

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
try {
  const { rows: users } = await pool.query(
    "SELECT id, email, display_name, district FROM users WHERE active = true AND role = 'district_editor' AND district = ANY($1) ORDER BY district, email",
    [GROUPS],
  );
  const missing = GROUPS.filter((group) => !users.some((u) => u.district === group));
  for (const user of users) console.log(`${apply ? 'новый пароль' : 'получит новый пароль'}: ${user.district} — логин «${user.email}»`);
  for (const group of missing) {
    console.log(group === AVD_OWNER
      ? `${apply ? 'создаётся' : 'будет создана'} учётка ${AVD_OWNER} — логин «${normalizeLogin(AVD_OWNER)}»`
      : `ВНИМАНИЕ: нет учётки района «${group}» — создайте её через scripts/create-user.js`);
  }
  if (!apply) {
    console.log('Это просмотр: пароли не изменены. Для выдачи добавьте --apply --out <файл.xlsx>.');
    process.exit(0);
  }

  const issued = [];
  for (const user of users) {
    const password = randomPassword();
    await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, await hashPassword(password)]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    issued.push({ group: user.district, login: user.email, password });
  }
  if (missing.includes(AVD_OWNER)) {
    const password = randomPassword();
    const login = normalizeLogin(AVD_OWNER);
    await pool.query(
      "INSERT INTO users (id, email, display_name, role, district, password_hash) VALUES ($1, $2, $3, 'district_editor', $4, $5)",
      [randomUUID(), login, AVD_OWNER, AVD_OWNER, await hashPassword(password)],
    );
    issued.push({ group: AVD_OWNER, login, password });
  }

  // Проверяем ровно то, чем будет пользоваться район: вход через публичный адрес.
  let verified = 0;
  for (const entry of issued) {
    try {
      const response = await fetch(`${publicUrl}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: entry.login, password: entry.password }),
      });
      const body = await response.json().catch(() => null);
      entry.ok = response.ok && body?.user?.email === entry.login;
    } catch { entry.ok = false; }
    if (entry.ok) verified += 1;
  }
  issued.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));

  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  const sheet = book.addWorksheet('Учётные записи');
  sheet.columns = [
    { header: 'Район / организация', key: 'group', width: 24 },
    { header: 'Логин', key: 'login', width: 24 },
    { header: 'Пароль', key: 'password', width: 22 },
    { header: 'Вход проверен', key: 'checked', width: 14 },
    { header: 'Текст для отправки', key: 'message', width: 90 },
  ];
  for (const entry of issued) {
    const row = sheet.addRow({
      group: entry.group, login: entry.login, password: entry.password, checked: entry.ok ? 'да' : 'НЕТ',
      message: [
        `${entry.group}: доступ к фотофиксации САО.`,
        `Логин: ${entry.login}`,
        `Пароль: ${entry.password}`,
        `ТПУ и парковки (фото по заданию): ${ATLAS}/object-maps/tpu-parking.html?district=${encodeURIComponent(entry.group)}`,
        `Остановки, ПП и подъезды: ${ATLAS}/object-maps/`,
        'Пароль никому не передавайте. Прежний пароль больше не действует.',
      ].join('\n'),
    });
    row.getCell('message').alignment = { wrapText: true, vertical: 'top' };
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const info = book.addWorksheet('Как работать');
  info.columns = [{ width: 110 }];
  for (const line of [
    'Оцифровка ТПУ и автомобильных парковок САО — фото по заданию',
    '',
    `1. Откройте карту: ${ATLAS}/object-maps/tpu-parking.html`,
    '2. Слева нажмите «Войти для назначения точек и отправки фото», введите логин и пароль со вкладки «Учётные записи».',
    '3. На карте и в списке видны только объекты вашего района (у АвД САО — объекты на балансе АвД).',
    '4. Откройте объект. В блоке «Фото по заданию» столько слотов, сколько фото требуется по объекту (если число не указано — один).',
    '5. В каждый свободный слот нажмите «Загрузить фото» и выберите снимок (JPEG, PNG или WEBP до 5 МБ). С телефона откроется камера.',
    '6. Фото уходит на проверку в префектуру. Принятое фото засчитывается; объект закрывается, когда приняты все его фото.',
    '7. Если фото отклонено, слот снова свободен, а под ним написано, что исправить. Загрузите в этот слот новое фото.',
    '',
    'Цвета маркеров: оранжевый — нет фото, жёлтый — в работе, синий — на проверке, красный — на доработке, зелёный — закрыт.',
    '',
    'ВНИМАНИЕ: файл содержит пароли. Отправляйте каждому району только его строку, не пересылайте файл целиком',
    'и удалите его после рассылки. Сменить пароль одной учётки: node scripts/set-password.js --login "<логин>".',
  ]) {
    const row = info.addRow([line]);
    if (!line || line.startsWith('ВНИМАНИЕ') || line.startsWith('Оцифровка')) row.font = { bold: true };
  }
  await book.xlsx.writeFile(out);

  console.log(`паролей выдано: ${issued.length}`);
  console.log(`вход проверен успешно: ${verified} из ${issued.length}`);
  console.log(`файл учёток: ${out}`);
  if (verified !== issued.length) process.exitCode = 1;
} finally {
  await pool.end();
}
