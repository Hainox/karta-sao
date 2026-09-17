// Проверки выгрузки фотографий архивом: раскладка по районам и видам, имена
// файлов по объекту и координатам, опись, сборка файла и очередь задач. Раскладка
// и имена — чистые функции, поэтому проверяются точными строками; сборка идёт на
// временном медиахранилище, чтобы не поднимать базу.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ARCHIVE_FILE_PATTERN, archiveFolders, archiveName, photoArchiveByTicket, photoArchiveEntries,
  photoArchiveJob, photoArchiveManifest, photoFileName, prunePhotoArchiveFiles, safeSegment,
  startPhotoArchiveJob, writePhotoArchive
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

test('архив собирается в файл: папки вида, имена и опись внутри', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sao-photo-media-'));
  const dir = await mkdtemp(join(tmpdir(), 'sao-photo-export-'));
  try {
    for (const key of [KEY_A, KEY_B]) await writeFile(join(root, key), Buffer.from([1, 2, 3]));

    const result = await writePhotoArchive(rows(), { root, dir, exportedAt: '2026-09-17T09:00:00.000Z' });

    assert.match(result.name, ARCHIVE_FILE_PATTERN);
    assert.equal(result.photos, 2);
    assert.equal(result.skipped, 2); // у остановки и подъезда файлов на диске нет
    assert.ok(result.bytes > 0);

    // Имена в zip лежат без сжатия, поэтому структуру видно прямо в байтах файла.
    const text = (await readFile(join(dir, result.name))).toString('utf8');
    assert.ok(text.includes('manifest.json'), 'опись внутри архива');
    assert.ok(text.includes('Аэропорт/ПП/'), 'папка вида');
    assert.ok(text.includes('ПП «Ленинградский проспект, 1» 55.79123, 37.51234.jpg'), 'имя объекта и координаты');
    // Оба кадра этого объекта лежат на диске — значит, оба и в архиве.
    assert.ok(text.includes('ПП «Ленинградский проспект, 1» 55.79123, 37.51234 (2).png'), 'повтор не потерян');
    // Кадров без файла на диске двое — они посчитаны пропущенными, а не собраны.
    assert.equal(result.photos + result.skipped, photoArchiveEntries(rows()).length);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('готовые архивы чистятся, посторонние файлы не трогаем', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sao-photo-export-'));
  try {
    const names = [];
    for (let index = 0; index < 4; index += 1) {
      const name = `sao-photo-2026-09-17-0000000${index}.zip`;
      await writeFile(join(dir, name), Buffer.from([index]));
      // Разное время правки: по нему и решаем, что старше.
      const stamp = new Date(Date.UTC(2026, 8, 17, 10, index));
      await utimes(join(dir, name), stamp, stamp);
      names.push(name);
    }
    await writeFile(join(dir, 'не-архив.txt'), 'посторонний файл');

    const removed = await prunePhotoArchiveFiles(dir, 2);

    assert.equal(removed, 2);
    const left = (await readdir(dir)).filter((name) => ARCHIVE_FILE_PATTERN.test(name)).sort();
    assert.deepEqual(left, [names[2], names[3]].sort());
    assert.ok((await readdir(dir)).includes('не-архив.txt'), 'посторонний файл остался');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('имя архива подходит для ссылки и не повторяется', () => {
  const first = archiveName('2026-09-17T09:00:00.000Z');
  assert.match(first, ARCHIVE_FILE_PATTERN);
  assert.notEqual(first, archiveName('2026-09-17T09:00:00.000Z'));
});

test('ход сборки показывает, сколько снимков уже упаковано', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sao-photo-media-'));
  const dir = await mkdtemp(join(tmpdir(), 'sao-photo-export-'));
  try {
    for (const key of [KEY_A, KEY_B]) await writeFile(join(root, key), Buffer.from([1, 2, 3]));
    const seen = [];
    await writePhotoArchive(rows(), { root, dir, onProgress: (progress) => seen.push({ ...progress }) });

    // Первый отчёт приходит сразу и говорит, сколько снимков предстоит упаковать:
    // иначе строка состояния выглядела бы как «0 из 0».
    assert.equal(seen[0].total, 2);
    assert.equal(seen[0].photos, 0);
    for (const progress of seen) {
      assert.equal(progress.total, 2, 'общее число снимков не меняется по ходу сборки');
      assert.ok(progress.photos <= progress.total, 'упаковано не больше, чем всего');
      assert.ok(progress.bytes >= 0);
    }
    assert.ok(seen[seen.length - 1].bytes > 0, 'к концу сборки байты записаны');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('задача сборки отдаёт статус, а готовый файл — по билету', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sao-photo-media-'));
  const dir = await mkdtemp(join(tmpdir(), 'sao-photo-export-'));
  try {
    await writeFile(join(root, KEY_A), Buffer.from([1]));
    const [pp] = rows();

    const job = startPhotoArchiveJob({ rows: [pp], root, dir });
    assert.equal(job.status, 'building');
    assert.match(job.id, /^[0-9a-f-]{36}$/);
    await job.done;

    assert.equal(job.status, 'ready');
    assert.equal(job.photos, 1);
    assert.match(job.name, ARCHIVE_FILE_PATTERN);
    assert.ok(job.ticket);
    assert.equal(photoArchiveJob(job.id), job);
    // Ссылку открывает браузер, поэтому доступ к готовому файлу даёт билет.
    assert.equal(photoArchiveByTicket(job.ticket), job);
    assert.equal(photoArchiveByTicket('чужой-билет'), null);
    assert.equal(photoArchiveByTicket(''), null);
    assert.equal(photoArchiveJob('нет-такой-задачи'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('сбой сборки остаётся в задаче, а не роняет сервис', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sao-photo-media-'));
  try {
    const [pp] = rows();
    // Каталог выгрузки — это файл, а не папка: сборка обязана упасть, но тихо.
    const dir = join(root, 'занято');
    await writeFile(dir, 'не папка');

    const job = startPhotoArchiveJob({ rows: [pp], root, dir });
    await job.done;

    assert.equal(job.status, 'failed');
    assert.ok(job.error);
    assert.equal(job.name, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
