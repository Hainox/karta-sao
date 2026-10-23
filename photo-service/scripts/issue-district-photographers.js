// Creates separate map-photo accounts without rotating existing photo-service users.
// Run on the server after backup and migrations. Never commit output XLSX to Git.
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { randomUUID, randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { hashPassword, normalizeLogin } from '../src/auth.js';
import { DISTRICT_SLUGS, districtMapUrl } from './prepare-district-map-accounts.js';

const apply = process.argv.includes('--apply');
const argument = name => { const index = process.argv.indexOf('--' + name); return index < 0 ? null : process.argv[index + 1]; };
const out = argument('out') && resolve(argument('out'));
if (apply && (!out || existsSync(out))) throw Error('Use --apply --out NEW-PRIVATE-FILE.xlsx; refusing to overwrite existing file.');
const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
const password = () => Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('')).join('-');
const rows = Object.keys(DISTRICT_SLUGS).sort((a,b)=>a.localeCompare(b,'ru')).map(district => ({
  district, login: normalizeLogin('map-photo-' + DISTRICT_SLUGS[district]),
  url: districtMapUrl(district),
}));
const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 1 });
const client = await pool.connect();
try {
  const { rows: roles } = await client.query("SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check' AND pg_get_constraintdef(oid) LIKE '%district_photographer%' LIMIT 1");
  if (!roles.length) throw Error('Apply migration 019_district_map_photographers.sql before account issuance.');
  const { rows: existing } = await client.query("SELECT district, email, active FROM users WHERE role = 'district_photographer'");
  if (!apply) {
    for (const row of rows) console.log(row.district + ': ' + row.login + ' (' + (existing.some(x => x.district === row.district) ? 'ALREADY EXISTS' : 'ready') + ')');
    console.log('Dry run; nothing changed.');
  } else {
    if (existing.length) throw Error('Some map photographer accounts already exist. Stop and audit instead of resetting or duplicating passwords.');
    await client.query('BEGIN');
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Карты районов');
    sheet.columns = [
      { header: 'Район', key: 'district', width: 26 },
      { header: 'Логин', key: 'login', width: 31 },
      { header: 'Пароль', key: 'password', width: 32 },
      { header: 'Карта', key: 'url', width: 67 },
      { header: 'Роль', key: 'role', width: 26 },
    ];
    for (const row of rows) {
      const secret = password();
      const collision = await client.query('SELECT 1 FROM users WHERE email = $1', [row.login]);
      if (collision.rowCount) throw Error('Login occupied: ' + row.login);
      await client.query("INSERT INTO users(id,email,display_name,role,district,password_hash) VALUES($1,$2,$3,'district_photographer',$4,$5)",
        [randomUUID(),row.login,'Карта района: '+row.district,row.district,await hashPassword(secret)]);
      sheet.addRow({ ...row, password: secret, role: 'district_photographer' });
    }
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    book.addWorksheet('Памятка').addRows([
      ['Точки назначает, переносит и поворачивает только префектура.'],
      ['Район входит на свою карту и загружает фото к назначенным точкам.'],
      ['Фото направляется на приёмку префектуре.'],
      ['Передавайте району только его логин и пароль.'],
    ]);
    await book.xlsx.writeFile(out);
    await client.query('COMMIT');
    console.log('Created 16 independent district photographer accounts. Credentials saved privately to: ' + out);
    console.log('Existing district_editor passwords/sessions and all photo points were not changed.');
  }
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
