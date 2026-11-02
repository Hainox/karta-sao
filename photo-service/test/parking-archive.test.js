// Архив фото парковок: папка района → папка объекта → «координаты объекта_N».
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadParkingArchive, parkingArchiveLayout, parkingObjectFolder, parkingPhotoName, PARKING_ARCHIVE_PREFIX } from '../src/parking-archive.js';
import { ARCHIVE_FILE_PATTERN, writePhotoArchive } from '../src/photos-archive.js';
import { SLOT_OBJECTS } from '../src/tpu-points/object-slots.js';

const objects = new Map([
  ['parking:1', { id: 'parking:1', label: 'Автопарковка (Дмитровское ш. 107)', sourceNumber: '1', group: 'Дмитровский', lat: 55.8851234, lon: 37.5432109 }],
  ['parking:2', { id: 'parking:2', label: 'Подъезд к кладбищу', sourceNumber: '2', group: 'АвД САО', lat: 55.91, lon: 37.52 }],
  ['tpu:3', { id: 'tpu:3', label: 'ТПУ', sourceNumber: '3', group: 'Аэропорт', lat: 55.8, lon: 37.5 }],
]);
const photo = (source, id, objectKey, uploadedAt, extra = {}) => ({ source, id, object_key: objectKey, photo_mime_type: 'image/jpeg', uploaded_at: uploadedAt, photo_size: 3, status: 'accepted', slot: null, ...extra });

test('имя снимка — координаты объекта и номер кадра', () => {
  assert.equal(parkingPhotoName(objects.get('parking:1'), 2, 'image/jpeg'), '55.885123, 37.543211_2.jpg');
  assert.equal(parkingPhotoName(objects.get('parking:1'), 1, 'image/png'), '55.885123, 37.543211_1.png');
  assert.equal(parkingPhotoName(null, 1, 'image/jpeg'), 'без координат_1.jpg');
  assert.equal(parkingObjectFolder(objects.get('parking:1')), 'Автопарковка (Дмитровское ш. 107) (1)', 'ID в папке различает одноимённые парковки');
});

test('раскладка: район → объект → кадры по времени загрузки, ТПУ не попадают', () => {
  const { entries, folders } = parkingArchiveLayout(objects, [
    photo('slot', 'b', 'parking:1', '2026-10-02T10:00:00Z', { slot: 1 }),
    photo('point', 'a', 'parking:1', '2026-10-01T10:00:00Z'),
    photo('point', 'c', 'parking:2', new Date('2026-10-03T10:00:00Z')),
    photo('point', 'd', 'tpu:3', '2026-10-03T10:00:00Z'),
  ]);
  assert.deepEqual(entries.map((e) => [e.path, e.photoId]), [
    ['АвД САО/Подъезд к кладбищу (2)/55.910000, 37.520000_1.jpg', 'c'],
    ['Дмитровский/Автопарковка (Дмитровское ш. 107) (1)/55.885123, 37.543211_1.jpg', 'a'],
    ['Дмитровский/Автопарковка (Дмитровское ш. 107) (1)/55.885123, 37.543211_2.jpg', 'b'],
  ]);
  assert.deepEqual(folders, ['АвД САО', 'АвД САО/Подъезд к кладбищу (2)', 'Дмитровский', 'Дмитровский/Автопарковка (Дмитровское ш. 107) (1)']);
  assert.equal(entries[0].uploadedAt, '2026-10-03T10:00:00.000Z');
});

test('у каждой парковки каталога есть координаты метки на карте', () => {
  const parking = [...SLOT_OBJECTS.values()].filter((o) => o.kind === 'parking');
  assert.ok(parking.length > 0);
  for (const object of parking) assert.ok(Number.isFinite(object.lat) && Number.isFinite(object.lon), object.id);
});

test('архив собирается из байтов базы и раскладывается по папкам', async () => {
  const bytes = { a: Buffer.from('AAA'), b: Buffer.from('BBB'), c: Buffer.from('CCC') };
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push(sql);
      if (sql.includes('photo_bytes')) return { rows: bytes[params[0]] ? [{ photo_bytes: bytes[params[0]] }] : [] };
      if (sql.includes('object_slot_photos')) return { rows: [photo('slot', 'b', 'parking:1', '2026-10-02T10:00:00Z', { slot: 1 })] };
      return { rows: [photo('point', 'a', 'parking:1', '2026-10-01T10:00:00Z'), photo('point', 'c', 'parking:2', '2026-10-03T10:00:00Z')] };
    },
  };
  const { entries, folders } = await loadParkingArchive(pool, objects);
  assert.ok(queries.every((sql) => !sql.includes('photo_bytes')), 'байты не читаются до упаковки');
  const dir = await mkdtemp(join(tmpdir(), 'parking-archive-'));
  try {
    const result = await writePhotoArchive([], { entries, folders, dir, prefix: PARKING_ARCHIVE_PREFIX, exportedAt: '2026-11-02T10:00:00.000Z' });
    assert.match(result.name, ARCHIVE_FILE_PATTERN);
    assert.ok(result.name.startsWith('sao-parking-2026-11-02-'));
    assert.equal(result.photos, 3);
    const listing = execFileSync('python3', ['-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({n:z.read(n).decode("utf-8","replace") for n in z.namelist() if not n.endswith("/")}))', join(dir, result.name)]);
    const files = JSON.parse(listing);
    assert.equal(files['Дмитровский/Автопарковка (Дмитровское ш. 107) (1)/55.885123, 37.543211_1.jpg'], 'AAA');
    assert.equal(files['Дмитровский/Автопарковка (Дмитровское ш. 107) (1)/55.885123, 37.543211_2.jpg'], 'BBB');
    assert.equal(files['АвД САО/Подъезд к кладбищу (2)/55.910000, 37.520000_1.jpg'], 'CCC');
    const manifest = JSON.parse(files['manifest.json']);
    assert.deepEqual([manifest.selection.objects, manifest.selection.photos], [2, 3]);
    assert.ok(manifest.files.every((file) => !('open' in file)), 'служебное open() в опись не попадает');
    assert.ok(queries.filter((sql) => sql.includes('photo_bytes')).length === 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
