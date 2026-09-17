// Проверки выгрузки фотографий архивом: раскладка по районам и видам, имена
// файлов по объекту и координатам и опись. Сборка списка — чистые функции,
// поэтому проверяются точными строками; поток проверяется на временном
// медиахранилище, чтобы не поднимать базу.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import {
  archiveFolders, photoArchiveEntries, photoArchiveManifest, photoFileName, safeSegment, streamPhotoArchive
} from '../src/photos-archive.js';

const KEY_A = '11111111-1111-1111-1111-111111111111.jpg';
const KEY_B = '22222222-2222-2222-2222-222222222222.png';
const KEY_C = '33333333-3333-3333-3333-333333333333.jpg';

const photo = (id, storageKey, extra = {}) => ({
  id, storageKey, mimeType: 'image/jpeg', byteSize: 100, uploadedAt: '2026-09-17T06:30:00.000Z',
  performer: 'Иванов И.И.', reviewStatus: 'confirmed', geoStatus: 'within_radius', sha256: 'a'.repeat(64), ...extra
});

function rows() {
  return [
    {
      object_key: 'pp-1', object_type: 'pp', district: 'Аэропорт', label: 'ПП «Ленинградский проспект, 1»',
      reference_points: [{ latitude: 55.79123, longitude: 37.51234 }],
      photos: [photo('p1', KEY_A), photo('p2', KEY_B, { mimeType: 'image/png' })]
    },
    {
      object_key: 'stop-1', object_type: 'stop', district: 'Аэропорт', label: 'ост. «Метро Сокол»',
      // Точки привязки нет: координаты берём у самого кадра.
      reference_points: [],
      photos: [photo('p3', KEY_C, { gpsLatitude: '55.80500', gpsLongitude: '37.51000' })]
    },
    {
      object_key: 'ent-1', object_type: 'entrance', district: 'Ховрино', label: 'ул. Дыбенко, 6, подъезд 2',
      reference_points: [], photos: [photo('p4', '44444444-4444-4444-4444-444444444444.webp', { mimeType: 'image/webp' })]
    }
  ];
}

test('сегмент пути не пропускает символы, запрещённые файловой системой', () => {
  assert.equal(safeSegment('ПП "Ленинградский/проспект"'), 'ПП _Ленинградский_проспект_');
  assert.equal(safeSegment('   '), 'Без района');
  assert.equal(safeSegment('', 'Прочее'), 'Прочее');
  assert.equal(safeSegment('а'.repeat(300)).length, 80);
});

test('имя файла — объект и координаты, повтор получает номер', () => {
  const [pp] = rows();
  assert.equal(photoFileName(pp, pp.photos[0], 1), 'ПП «Ленинградский проспект, 1» 55.79123, 37.51234.jpg');
  // Второй кадр того же объекта не затирает первый.
  assert.equal(photoFileName(pp, pp.photos[1], 2), 'ПП «Ленинградский проспект, 1» 55.79123, 37.51234 (2).png');
});

test('координаты берутся у объекта, при их отсутствии — у кадра', () => {
  const [, stop, entrance] = rows();
  assert.equal(photoFileName(stop, stop.photos[0], 1), 'ост. «Метро Сокол» 55.80500, 37.51000.jpg');
  // Ни у объекта, ни у кадра координат нет — файл всё равно остаётся.
  assert.match(photoFileName(entrance, entrance.photos[0], 1), / без координат\.webp$/);
});

test('район — папка, вид — подпапка, и все три вида есть в каждом районе', () => {
  // Порядок папок — русская сортировка: «Остановки», «Подъезды», «ПП».
  const folders = archiveFolders(rows());
  assert.deepEqual(folders, [
    'Аэропорт/Остановки', 'Аэропорт/Подъезды', 'Аэропорт/ПП',
    'Ховрино/Остановки', 'Ховрино/Подъезды', 'Ховрино/ПП'
  ]);
});

test('объект без района попадает в папку «Без района»', () => {
  const orphan = { object_key: 'x', object_type: 'stop', district: null, label: 'ост. без района', reference_points: [], photos: [photo('p5', KEY_A)] };
  const entries = photoArchiveEntries([orphan]);
  assert.match(entries[0].path, /^Без района\/Остановки\//);
});

test('путь файла собирается из района, вида и имени объекта', () => {
  const entries = photoArchiveEntries(rows());
  assert.deepEqual(entries.map((entry) => entry.path), [
    'Аэропорт/ПП/ПП «Ленинградский проспект, 1» 55.79123, 37.51234.jpg',
    'Аэропорт/ПП/ПП «Ленинградский проспект, 1» 55.79123, 37.51234 (2).png',
    'Аэропорт/Остановки/ост. «Метро Сокол» 55.80500, 37.51000.jpg',
    'Ховрино/Подъезды/ул. Дыбенко, 6, подъезд 2 без координат.webp'
  ]);
  // Ключ хранилища нужен сервису, но наружу в опись не идёт.
  assert.equal(entries[0].storageKey, KEY_A);
});

test('опись перечисляет папки и файлы и считает объекты с фото', () => {
  const list = rows();
  const entries = photoArchiveEntries(list);
  const manifest = photoArchiveManifest(list, entries, { exportedAt: '2026-09-17T09:00:00.000Z', district: null });
  assert.equal(manifest.archive_version, 'sao_photo_archive_v1');
  assert.deepEqual(manifest.selection, { district: 'весь САО', objects: 3, objects_with_photos: 3, photos: 4, skipped: 0 });
  assert.equal(manifest.files.length, 4);
  assert.ok(!('storageKey' in manifest.files[0]));
  assert.equal(manifest.files[0].objectType, 'pp');
  assert.equal(manifest.files[0].label, 'ПП «Ленинградский проспект, 1»');
});

test('архив уходит потоком и содержит опись, папки и файлы', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sao-photo-archive-'));
  try {
    for (const key of [KEY_A, KEY_B, KEY_C]) await writeFile(join(root, key), Buffer.from([1, 2, 3]));
    const chunks = [];
    const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });

    const result = await streamPhotoArchive(response, rows(), { root, exportedAt: '2026-09-17T09:00:00.000Z' });
    const buffer = Buffer.concat(chunks);
    const text = buffer.toString('utf8');

    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK');
    assert.equal(result.photos, 3);
    assert.equal(result.skipped, 1); // у подъезда файла на диске нет
    // Имена в архиве лежат без сжатия, поэтому структуру видно прямо в байтах.
    assert.ok(text.includes('manifest.json'), 'опись внутри архива');
    assert.ok(text.includes('Аэропорт/ПП/'), 'папка вида');
    assert.ok(text.includes('Аэропорт/ПП/ПП «Ленинградский проспект, 1» 55.79123, 37.51234.jpg'), 'имя объекта и координаты');
    assert.ok(!text.includes('без координат'), 'кадр без файла в архив не попал');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('пропавший файл не роняет архив, а считается пропущенным', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sao-photo-archive-'));
  try {
    // На диске лежит только первый кадр: второй пропал после выборки.
    await writeFile(join(root, KEY_A), Buffer.from([1, 2, 3]));
    const [pp] = rows();
    const chunks = [];
    const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });

    const result = await streamPhotoArchive(response, [pp], { root });
    const text = Buffer.concat(chunks).toString('utf8');

    assert.equal(result.photos, 1);
    assert.equal(result.skipped, 1);
    assert.ok(text.includes('ПП «Ленинградский проспект, 1» 55.79123, 37.51234.jpg'), 'кадр с диска в архиве');
    assert.ok(!text.includes('55.79123, 37.51234 (2).png'), 'пропавший кадр в архив не добавлен');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
