// Подготовка раздельного доступа 16 районам к картам районов.
// По умолчанию только предварительный просмотр; --apply создаёт только отсутствующие учётки.
// Действующие пароли и сессии существующих районных учёток не меняются.
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { hashPassword, normalizeLogin } from '../src/auth.js';
import { DISTRICTS } from '../src/tpu-points/validation.js';

export const DISTRICT_SLUGS = Object.freeze({
  Аэропорт: 'aeroport', Беговой: 'begovoy', Бескудниковский: 'beskudnikovskiy', Войковский: 'voykovskiy',
  'Восточное Дегунино': 'vostochnoe-degunino', Головинский: 'golovinskiy', Дмитровский: 'dmitrovskiy',
  'Западное Дегунино': 'zapadnoe-degunino', Коптево: 'koptevo', Левобережный: 'levoberezhnyy',
  Молжаниновский: 'molzhaninovskiy', Савеловский: 'savelovskiy', Сокол: 'sokol',
  Тимирязевский: 'timiryazevskiy', Ховрино: 'hovrino', Хорошевский: 'horoshevskiy',
});

const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
export function generateDistrictPassword() {
  return Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('')).join('-');
}

export function districtMapUrl(district, baseUrl = 'https://hainox.github.io/karta-sao') {
  const slug = DISTRICT_SLUGS[district];
  if (!slug) throw new Error(`Неизвестный район: ${district}`);
  return `${baseUrl.replace(/\/$/, '')}/districts/${slug}.html`;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const apply = process.argv.includes('--apply');
  const out = argument('out');
  if (apply && !out) {
    console.error('Для выдачи новых паролей используйте --apply --out <файл.xlsx>.');
    process.exit(2);
  }
  const baseUrl = (argument('map-base-url') || 'https://hainox.github.io/karta-sao').replace(/\/$/, '');
  const districts = [...DISTRICTS].sort((a, b) => a.localeCompare(b, 'ru'));
  const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
  try {
    const { rows: users } = await pool.query(
      "SELECT id, email, display_name, district, role, active FROM users WHERE district = ANY($1) OR email = ANY($2) ORDER BY district, email",
      [districts, districts.map(normalizeLogin)],
    );
    const issued = [];
    for (const district of districts) {
      const current = users.find((user) => user.role === 'district_editor' && user.district === district);
      if (current) {
        issued.push({ district, login: current.email, password: '', status: current.active ? 'Действующий вход сохранён' : 'Учётка отключена; не менялась', url: districtMapUrl(district, baseUrl) });
        continue;
      }
      const login = normalizeLogin(district);
      if (users.some((user) => user.email === login)) {
        issued.push({ district, login, password: '', status: 'Логин занят другой учёткой; не менялась', url: districtMapUrl(district, baseUrl) });
        continue;
      }
      const password = apply ? generateDistrictPassword() : 'создаётся при --apply';
      if (apply) {
        await pool.query(
          "INSERT INTO users (id, email, display_name, role, district, password_hash) VALUES ($1, $2, $3, 'district_editor', $4, $5)",
          [randomUUID(), login, district, district, await hashPassword(password)],
        );
      }
      issued.push({ district, login, password, status: apply ? 'Новая учётка создана' : 'Будет создана', url: districtMapUrl(district, baseUrl) });
    }

    const book = new ExcelJS.Workbook();
    book.creator = 'Фотослужба САО';
    const sheet = book.addWorksheet('Входы районов');
    sheet.columns = [
      { header: 'Район', key: 'district', width: 26 },
      { header: 'Логин', key: 'login', width: 30 },
      { header: 'Пароль нового входа', key: 'password', width: 27 },
      { header: 'Состояние', key: 'status', width: 28 },
      { header: 'Карта района', key: 'url', width: 66 },
    ];
    for (const entry of issued) {
      const row = sheet.addRow(entry);
      row.getCell('url').value = { text: 'Открыть карту района', hyperlink: entry.url };
      row.getCell('url').font = { color: { argb: 'FF0C5AA6' }, underline: true };
    }
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    const guide = book.addWorksheet('Памятка');
    guide.columns = [{ width: 100 }];
    for (const line of [
      'Вход на карту района для разметки точек фотофиксации',
      'Откройте ссылку из столбца «Карта района» и нажмите «Вход» рядом с инструментом «Точки съёмки».',
      'Войдите под выданной учётной записью. Кнопка «Разметка» ставит точку и направление съёмки.',
      'Новая точка отправляется префектуре на приёмку. Фотослот откроется только после принятия точки.',
      'Действующие пароли не сбрасываются. Файл содержит пароли только новых учёток; передавайте каждому району только его строку.',
      'Выполните node scripts/prepare-district-map-accounts.js сначала без --apply для предварительного просмотра.',
    ]) guide.addRow([line]);
    if (apply) await book.xlsx.writeFile(out);
    else if (out) await book.xlsx.writeFile(out);
    console.log(`Районных карт: ${districts.length}. Новых учёток ${apply ? 'создано' : 'к созданию'}: ${issued.filter((entry) => entry.password).length}.`);
    if (out) console.log(`Файл: ${out}`);
    if (!apply) console.log('Предварительный просмотр: база данных не изменена.');
  } finally {
    await pool.end();
  }
}
