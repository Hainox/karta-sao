// Проверяет отчёты на живом сервисе: входит по учётке из файла учёток,
// скачивает PDF и Excel и проверяет их структуру. Пароль читается из файла
// и в вывод не попадает.
//
//   node scripts/check-reports.js --accounts /out/accounts.xlsx --out /out [--role Префектура]
import ExcelJS from 'exceljs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

const accountsPath = argument('accounts');
const outDir = argument('out') || '.';
const wantedRole = argument('role') || 'Префектура';
const baseUrl = (argument('public-url') || process.env.PHOTO_SERVICE_PUBLIC_URL || 'https://obhod-sao.ru/photo-api').replace(/\/$/, '');

if (!accountsPath) {
  console.error('Usage: node scripts/check-reports.js --accounts <accounts.xlsx> [--out DIR] [--role Префектура]');
  process.exit(2);
}

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(accountsPath);
const sheet = workbook.getWorksheet('Учётные записи');
if (!sheet) throw new Error('в файле учёток нет листа «Учётные записи»');

let account = null;
sheet.eachRow((row, index) => {
  if (index === 1) return;
  const values = row.values;
  if (!account && String(values[4] || '').startsWith(wantedRole)) {
    account = { login: String(values[2]), password: String(values[3]) };
  }
});
if (!account) throw new Error(`в файле учёток нет роли «${wantedRole}»`);

const loginResponse = await fetch(`${baseUrl}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login: account.login, password: account.password }),
});
if (!loginResponse.ok) throw new Error(`вход не выполнен: HTTP ${loginResponse.status}`);
const cookie = (loginResponse.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]).join('; ');
const session = { token: (await loginResponse.json()).token, cookie };

async function fetchReport(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${session.token}`, Cookie: session.cookie },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, buffer };
}

const results = [];
const pdf = await fetchReport('/reports/export.pdf');
const pdfRaw = pdf.buffer.toString('latin1');
await writeFile(join(outDir, 'check-report.pdf'), pdf.buffer);
results.push(['PDF статус', pdf.status]);
results.push(['PDF размер', `${pdf.buffer.length} байт`]);
results.push(['PDF шрифт с ToUnicode', pdfRaw.includes('/ToUnicode') && pdfRaw.includes('/FontFile2')]);
results.push(['PDF без Helvetica', !pdfRaw.includes('/Helvetica')]);

const xlsx = await fetchReport('/reports/export.xlsx');
await writeFile(join(outDir, 'check-report.xlsx'), xlsx.buffer);
results.push(['Excel статус', xlsx.status]);
results.push(['Excel размер', `${xlsx.buffer.length} байт`]);
results.push(['Excel это zip', xlsx.buffer[0] === 0x50 && xlsx.buffer[1] === 0x4b]);

for (const [label, value] of results) console.log(`${label}: ${value}`);

const failed = results.some(([label, value]) => value === false);
if (failed) process.exitCode = 1;
