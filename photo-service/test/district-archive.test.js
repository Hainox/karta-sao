// Архив фото кабинета приёмки: папка района → папка объекта → «координаты_N».
// Раскладка и имена проверяются точными строками, сборка — на временном
// каталоге, без базы: байты кадров подставляет тестовая read().
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ARCHIVE_FILE_PATTERN, archiveName, writePhotoArchive } from '../src/photos-archive.js';
import { archiveObjectFolder, archivePhotoName, districtArchiveLayout } from '../src/tpu-points/district-archive.js';
import { createAvdSidewalkPhotosRouter } from '../src/tpu-points/avd-sidewalk-photos.js';
import { createObjectPhotoPointsRouter } from '../src/tpu-points/object-photo-points.js';
import { createPlaygroundPhotoRouter } from '../src/tpu-points/playground-photo.js';
import { createSidewalkPointsRouter } from '../src/tpu-points/sidewalk-points.js';

const row = (extra = {}) => ({
  point_id: 'point-1', object_id: '951113439', label: 'Башиловка Нов. ул. 14', district: 'Беговой',
  latitude: 55.7901, longitude: 37.5601, heading: 90,
  photo_id: 'photo-1', photo_status: 'accepted', photo_filename: 'IMG_0001.JPG',
  uploaded_at: '2026-11-09T10:00:00.000Z', ...extra,
});

test('папка объекта — подпись и номер, имя файла — координаты и номер кадра', () => {
  assert.equal(archiveObjectFolder(row()), 'Башиловка Нов. ул. 14 (951113439)');
  assert.equal(archivePhotoName(row(), 1), '55.790100, 37.560100_1.jpg');
  assert.equal(archivePhotoName(row({ photo_filename: 'frame.PNG' }), 2), '55.790100, 37.560100_2.png');
  assert.equal(archivePhotoName(row({ latitude: null, longitude: null }), 1), 'без координат_1.jpg');
  // Без номера объекта в папке остаётся короткий ID точки, а не пустые скобки.
  assert.equal(archiveObjectFolder(row({ object_id: null, point_id: 'abcdef12-3456-7890' })), 'Башиловка Нов. ул. 14 (abcdef12)');
});

test('раскладка: район → объект → кадры, точки без фото пропускаются', () => {
  const { entries, folders } = districtArchiveLayout([
    row({ point_id: 'p2', object_id: '2', label: 'Сокол, ул. 2', district: 'Сокол', photo_id: 'f2', photo_status: 'pending', uploaded_at: '2026-11-09T11:00:00.000Z' }),
    row(),
    row({ point_id: 'p3', label: 'Точка без фото', photo_id: null }),
  ]);
  assert.deepEqual(entries.map((entry) => [entry.path, entry.photoId]), [
    ['Беговой/Башиловка Нов. ул. 14 (951113439)/55.790100, 37.560100_1.jpg', 'photo-1'],
    ['Сокол/Сокол, ул. 2 (2)/55.790100, 37.560100_1.jpg', 'f2'],
  ]);
  assert.deepEqual(folders, [
    'Беговой', 'Беговой/Башиловка Нов. ул. 14 (951113439)',
    'Сокол', 'Сокол/Сокол, ул. 2 (2)',
  ]);
  assert.equal(entries[1].status, 'pending');
});

test('отклонённые кадры в архив не попадают: в строке очереди нет активного фото', () => {
  const { entries } = districtArchiveLayout([row({ photo_id: null, photo_status: null, rejected_photo_id: 'old' })]);
  assert.deepEqual(entries, []);
});

test('архив раздела собирается в файл с описью', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'district-archive-'));
  try {
    const { entries, folders } = districtArchiveLayout([row(), row({ point_id: 'p2', object_id: '2', label: 'Сокол, ул. 2', district: 'Сокол', photo_id: 'f2' })]);
    const bytes = { 'photo-1': Buffer.from('AAA'), f2: Buffer.from('BBB') };
    for (const entry of entries) entry.read = async () => bytes[entry.photoId];
    const result = await writePhotoArchive([], {
      entries, folders, dir, prefix: 'sao-district-playgrounds', exportedAt: '2026-11-09T12:00:00.000Z',
    });
    assert.match(result.name, ARCHIVE_FILE_PATTERN);
    assert.ok(result.name.startsWith('sao-district-playgrounds-2026-11-09-'));
    assert.equal(result.photos, 2);
    const listing = execFileSync('python3', ['-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({n:z.read(n).decode("utf-8","replace") for n in z.namelist() if not n.endswith("/")}))', join(dir, result.name)]);
    const files = JSON.parse(listing);
    assert.equal(files['Беговой/Башиловка Нов. ул. 14 (951113439)/55.790100, 37.560100_1.jpg'], 'AAA');
    assert.equal(files['Сокол/Сокол, ул. 2 (2)/55.790100, 37.560100_1.jpg'], 'BBB');
    const manifest = JSON.parse(files['manifest.json']);
    assert.deepEqual([manifest.selection.objects, manifest.selection.photos], [2, 2]);
    assert.ok(manifest.files.every((file) => !('read' in file)), 'служебное read() в опись не попадает');
    assert.equal(manifest.folders.length, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const archivePaths = (router) => router.stack
  .flatMap((layer) => layer.route ? [layer.route.path] : [])
  .filter((path) => path.includes('photos.zip'));

// Адрес кнопки в кабинете — mode().base + '/photos.zip/prepare', поэтому у каждого
// раздела маршрут должен стоять ровно под его базой, а у въездных групп — ещё и
// под /district-photos.
test('маршруты архива зарегистрированы в каждом разделе кабинета', () => {
  const authenticate = (_req, _res, next) => next();
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const expected = ['/photos.zip/prepare', '/photos.zip/prepare/:id'].sort();
  assert.deepEqual(archivePaths(createPlaygroundPhotoRouter({ pool, authenticate })).sort(), expected);
  assert.deepEqual(archivePaths(createSidewalkPointsRouter({ pool, authenticate, boundary: {} })).sort(), expected);
  assert.deepEqual(archivePaths(createObjectPhotoPointsRouter({ repository: {}, authenticate, boundary: {} })).sort(),
    ['/district-photos/photos.zip/prepare', '/district-photos/photos.zip/prepare/:id'].sort());
  const avd = createAvdSidewalkPhotosRouter({
    authenticate, pool, scope: 'district',
    loadCatalog: async () => ({ districtPoints: [], avdPoints: [], districtFrames: new Map(), avdFrames: new Map() }),
    loadEdits: async () => new Map(), mergePoint: (point) => point,
  });
  assert.deepEqual(archivePaths(avd).sort(), expected);
});

test('имя архива каждого раздела проходит проверку и не считается чужим', () => {
  for (const prefix of ['sao-district-entrances', 'sao-district-playgrounds', 'sao-district-sidewalks', 'sao-district-odh']) {
    assert.match(archiveName('2026-11-09T12:00:00.000Z', prefix), ARCHIVE_FILE_PATTERN, prefix);
  }
  assert.doesNotMatch('sao-district-2026-11-09-00000000.zip', ARCHIVE_FILE_PATTERN);
});
