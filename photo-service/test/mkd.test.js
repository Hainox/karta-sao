import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  MKD_PHOTO_LIMIT, mkdArchiveRows, mkdLimitVerdict, mkdRouteVerdict, mkdSummary, mkdWriteVerdict,
} from '../src/mkd.js';
import { archiveFolders, archiveName, ARCHIVE_FILE_PATTERN, MKD_TYPE_FOLDERS, photoArchiveEntries } from '../src/photos-archive.js';

const mkd = { role: 'mkd_editor', district: null };
const prefecture = { role: 'prefecture_admin', district: null };
const district = { role: 'district_editor', district: 'Сокол' };

test('учётке МКД закрыта вся фотофиксация', () => {
  for (const path of ['/photos', '/reports/summary', '/reports/export.xlsx', '/review/queue', '/objects/resolve', '/reports/daily']) {
    const verdict = mkdRouteVerdict(mkd, path);
    assert.equal(verdict.ok, false, path);
    assert.equal(verdict.status, 403);
    assert.equal(verdict.code, 'mkd_scope');
  }
  assert.equal(mkdRouteVerdict(mkd, '/auth/me').ok, true);
  assert.equal(mkdRouteVerdict(mkd, '/mkd/summary').ok, true);
  assert.equal(mkdRouteVerdict(mkd, '/mkd/photos').ok, true);
});

test('раздел МКД открыт только отделу и префектуре', () => {
  assert.equal(mkdRouteVerdict(prefecture, '/mkd/summary').ok, true);
  const verdict = mkdRouteVerdict(district, '/mkd/summary');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'mkd_role_required');
  // Остальные учётки в свои ручки ходят как раньше.
  assert.equal(mkdRouteVerdict(district, '/reports/summary').ok, true);
  assert.equal(mkdRouteVerdict(prefecture, '/reports/summary').ok, true);
});

test('загружать и удалять фото первого этажа может только отдел МКД', () => {
  assert.equal(mkdWriteVerdict(mkd).ok, true);
  assert.equal(mkdWriteVerdict(prefecture).code, 'mkd_read_only');
  assert.equal(mkdWriteVerdict(district).ok, false);
});

test('к подъезду не больше десяти фото первого этажа', () => {
  assert.equal(MKD_PHOTO_LIMIT, 10);
  assert.equal(mkdLimitVerdict(0).ok, true);
  assert.equal(mkdLimitVerdict(9).ok, true);
  const full = mkdLimitVerdict(10);
  assert.equal(full.ok, false);
  assert.equal(full.status, 409);
  assert.equal(full.code, 'mkd_photo_limit');
});

test('сводка считает подъезды с фото, а не сами фото', () => {
  const summary = mkdSummary(
    [{ district: 'Сокол', total: 4 }, { district: 'Аэропорт', total: 2 }, { district: null, total: 1 }],
    [
      { source_id: 'injob:1', district: 'Сокол', photos: 3 },
      { source_id: 'injob:2', district: 'Сокол', photos: 1 },
      { source_id: 'injob:9', district: 'Аэропорт', photos: 0 },
    ],
  );
  assert.deepEqual(summary.overall, { total: 7, withPhoto: 2, without: 5, photos: 4, percent: 29 });
  assert.deepEqual(summary.byDistrict.map((row) => row.district), ['Аэропорт', 'Сокол', 'Без района']);
  const sokol = summary.byDistrict.find((row) => row.district === 'Сокол');
  assert.deepEqual(sokol, { district: 'Сокол', total: 4, withPhoto: 2, photos: 4, without: 2, percent: 50 });
  assert.deepEqual(summary.points, { 'injob:1': 3, 'injob:2': 1 });
  assert.equal(summary.category, 'Первый этаж');
});

test('пустая сводка не делит на ноль', () => {
  assert.deepEqual(mkdSummary().overall, { total: 0, withPhoto: 0, without: 0, photos: 0, percent: 0 });
});

test('архив МКД раскладывается по папкам «Район / Первый этаж»', () => {
  const rows = mkdArchiveRows([
    { id: 'a', source_id: 'injob:1', object_key: 'k1', district: 'Сокол', label: 'ул. Балтийская, 6 · подъезд 1', reference_points: [{ latitude: 55.8, longitude: 37.5 }], storage_key: '00000000-0000-0000-0000-000000000001.jpg', mime_type: 'image/jpeg' },
    { id: 'b', source_id: 'injob:1', object_key: 'k1', district: 'Сокол', label: 'ул. Балтийская, 6 · подъезд 1', reference_points: [{ latitude: 55.8, longitude: 37.5 }], storage_key: '00000000-0000-0000-0000-000000000002.jpg', mime_type: 'image/jpeg' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].photos.length, 2);
  assert.deepEqual(archiveFolders(rows, MKD_TYPE_FOLDERS), ['Сокол/Первый этаж']);
  const entries = photoArchiveEntries(rows, MKD_TYPE_FOLDERS);
  assert.ok(entries.every((entry) => entry.path.startsWith('Сокол/Первый этаж/')));
  assert.match(entries[1].path, /\(2\)\.jpg$/);
});

test('архив МКД называется отдельно и проходит проверку имени', () => {
  const name = archiveName('2026-09-29T10:00:00.000Z', 'sao-mkd');
  assert.match(name, /^sao-mkd-2026-09-29-/);
  assert.match(name, ARCHIVE_FILE_PATTERN);
});

// server.js поднимает сокет при импорте, поэтому связку проверяем по исходнику.
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('проверка раздела МКД стоит до всех ручек фотофиксации', () => {
  const gate = server.indexOf('mkdRouteVerdict(user, pathname)');
  assert.ok(gate > 0, 'нет проверки mkdRouteVerdict');
  const firstRoute = server.indexOf("pathname === '/auth/me' && request.method === 'GET'");
  assert.ok(gate < firstRoute, 'проверка МКД стоит после ручек');
});

test('отчёты фотофиксации не читают таблицу первых этажей', async () => {
  for (const file of ['reports.js', 'report.js', 'headquarters.js', 'daily.js', 'exports.js', 'checks.js']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.ok(!source.includes('mkd_floor_photos'), `${file} читает mkd_floor_photos`);
  }
});
