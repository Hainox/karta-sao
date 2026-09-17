import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import request from 'supertest';
import { createApp } from '../app.js';
import { hashPassword } from '../lib/auth.js';
import { MAX_GEOMETRY_VERTICES, payloadHash, validateChangeSet } from '../lib/validation.js';

const publishedBoundary = JSON.parse(fs.readFileSync(new URL('../../odh-map/layers/sao_boundary_wgs84.geojson', import.meta.url), 'utf8'));

const SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
// В базе идентификаторы — uuid, поэтому заглушка повторяет тот же формат.
function fakeId(prefix, index) {
  return `${prefix}000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
const boundary = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[37, 55], [38, 55], [38, 56], [37, 56], [37, 55]]] }, properties: {} }]
};

function changeSet({ district = 'Аэропорт', author = 'Иванов И.И.', feature } = {}) {
  return {
    type: 'FeatureCollection', change_set_version: 'district_change_set_v2', district, author,
    created_at: '2026-09-08T10:00:00.000Z', features: [feature || {
      type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.1, 55.1], [37.2, 55.2]] },
      properties: { district, author, change_type: 'queue', queue_priority: '1', address: 'Тестовый маршрут', nozzle_direction: 'both', route_start: [37.1, 55.1], route_end: [37.2, 55.2], route_direction: 'start_to_end' }
    }]
  };
}

async function fixture() {
  const editorPassword = '12345678';
  const reviewerPassword = 'reviewer-password-123';
  const prefecturePassword = 'prefecture-password-123';
  const users = [
    { id: 'editor-1', email: 'editor@example.test', password_hash: await hashPassword(editorPassword), role: 'district_editor', district: 'Аэропорт' },
    { id: 'unassigned-editor-1', email: 'unassigned@example.test', password_hash: await hashPassword(editorPassword), role: 'district_editor', district: null },
    { id: 'reviewer-1', email: 'reviewer@example.test', password_hash: await hashPassword(reviewerPassword), role: 'reviewer', district: null },
    { id: 'prefecture-1', email: 'prefecture@example.test', password_hash: await hashPassword(prefecturePassword), role: 'prefecture_admin', district: null }
  ];
  const submissions = [];
  const photoMarkers = [];
  const repository = {
    async findUserByEmail(email) { return users.find((user) => user.email === email) || null; },
    async createSubmission(input) {
      const item = { id: fakeId('5b', submissions.length + 1), district: input.changeSet.district, author: input.changeSet.author, created_by: input.createdBy, original_filename: input.originalFilename, payload_sha256: input.payloadSha256, change_set: input.changeSet, status: 'submitted', submitted_at: '2026-09-08T10:01:00.000Z' };
      submissions.push(item); return item;
    },
    async listSubmissions({ status, district } = {}) { return submissions.filter((item) => (!status || item.status === status) && (!district || item.district === district)); },
    // Счётчик приёмки служба отдаёт готовыми числами, поэтому и подделка — числа.
    async submissionStats() {
      return {
        sets: { total: 3, submitted: 1, approved: 1, rejected: 1 },
        objects: { total: 9, submitted: 4, approved: 4, rejected: 1 },
        lastDistrict: 'Аэропорт',
        lastSubmittedAt: '2026-09-08T10:01:00.000Z'
      };
    },
    // Отчёт по маршрутам приходит уже сгруппированным: две строки одного района.
    async routeReportRows() {
      return [
        { district: 'Аэропорт', status: 'submitted', change_type: 'queue', count: 2, lastSubmittedAt: '2026-09-08T10:01:00.000Z' },
        { district: 'Аэропорт', status: 'approved', change_type: 'rotor_snow_storage_zone', count: 1, lastSubmittedAt: '2026-09-08T10:01:00.000Z' }
      ];
    },
    async reviewSubmission({ id, status, reviewerId, comment }) {
      const item = submissions.find((candidate) => candidate.id === id);
      if (!item) return null;
      Object.assign(item, { status, reviewed_by: reviewerId, review_comment: comment, reviewed_at: '2026-09-08T10:02:00.000Z' }); return item;
    },
    async listPhotoMarkers() { return photoMarkers.map(({ photo_bytes, ...marker }) => ({ ...marker, has_photo: Boolean(photo_bytes) })); },
    async createPhotoMarker({ longitude, latitude, note, legacySourceId, createdBy }) {
      const existing = legacySourceId && photoMarkers.find((marker) => marker.legacy_source_id === legacySourceId);
      if (existing) return { ...existing, has_photo: Boolean(existing.photo_bytes), imported: true };
      const marker = { id: fakeId('f0', photoMarkers.length + 1), longitude, latitude, note, legacy_source_id: legacySourceId, created_by: createdBy, photo_bytes: null, photo_mime_type: null, photo_filename: null, photo_size: null, created_at: '2026-09-08T10:03:00.000Z', updated_at: '2026-09-08T10:03:00.000Z' };
      photoMarkers.push(marker); return { ...marker, has_photo: false };
    },
    async updatePhotoMarkerNote({ id, note }) { const marker = photoMarkers.find((candidate) => candidate.id === id); if (!marker) return null; marker.note = note; return { ...marker, has_photo: Boolean(marker.photo_bytes) }; },
    async setPhotoMarkerPhoto({ id, bytes, mimeType, filename }) { const marker = photoMarkers.find((candidate) => candidate.id === id); if (!marker) return null; Object.assign(marker, { photo_bytes: bytes, photo_mime_type: mimeType, photo_filename: filename, photo_size: bytes.length }); return { ...marker, has_photo: true }; },
    async getPhotoMarkerPhoto(id) { const marker = photoMarkers.find((candidate) => candidate.id === id); return marker ? { photo_bytes: marker.photo_bytes, photo_mime_type: marker.photo_mime_type, photo_filename: marker.photo_filename } : null; },
    async deletePhotoMarkerPhoto({ id }) { const marker = photoMarkers.find((candidate) => candidate.id === id); if (!marker?.photo_bytes) return null; Object.assign(marker, { photo_bytes: null, photo_mime_type: null, photo_filename: null, photo_size: null }); return { ...marker, has_photo: false }; },
    async deletePhotoMarker({ id }) { const index = photoMarkers.findIndex((candidate) => candidate.id === id); if (index < 0) return null; return photoMarkers.splice(index, 1)[0]; }
  };
  return { api: request(createApp({ repository, boundary, jwtSecret: SECRET, allowedOrigins: ['https://map.example.test'] })), editorPassword, reviewerPassword, prefecturePassword };
}

async function login(api, email, password) {
  const response = await api.post('/api/auth/login').send({ email, password }).expect(200);
  return response.body.token;
}

function binaryParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

function unzipEntry(zip, expectedName) {
  let endOffset = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  assert.notEqual(endOffset, -1, 'ZIP end record exists');
  let offset = zip.readUInt32LE(endOffset + 16);
  const entryCount = zip.readUInt16LE(endOffset + 10);
  for (let index = 0; index < entryCount; index++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, 'central directory entry exists');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === expectedName) {
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      return method === 8 ? inflateRawSync(compressed) : compressed;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`ZIP entry not found: ${expectedName}`);
}

test('валидирует зоны накопления роторного снега', () => {
  const polygon = [[37.1, 55.1], [37.2, 55.1], [37.2, 55.2], [37.1, 55.1]];
  const set = changeSet({ feature: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [polygon] }, properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'rotor_snow_storage_zone', address: 'Тестовая зона' } } });
  assert.deepEqual(validateChangeSet(set, boundary), { valid: true, errors: [] });
});

test('отклоняет маршрут, у которого обе точки внутри САО, а сегмент выходит за границу', () => {
  const start = [37.3568222107043, 55.932847832297185];
  const end = [37.378520597289246, 55.9181242255081];
  const set = changeSet({ feature: {
    type: 'Feature', geometry: { type: 'LineString', coordinates: [start, end] },
    properties: { district: 'Молжаниновский', author: 'Иванов И.И.', change_type: 'queue', queue_priority: '1', address: 'Тестовый маршрут', nozzle_direction: 'both', route_start: start, route_end: end, route_direction: 'start_to_end' }
  } });
  set.district = 'Молжаниновский';
  assert.equal(validateChangeSet(set, publishedBoundary).valid, false);
});

test('отклоняет чрезмерно детальную геометрию до проверки границ', () => {
  const unreadBoundary = { get features() { throw new Error('Проверка границ не должна запускаться для oversized geometry.'); } };
  const oversizedCoordinates = [
    Array.from({ length: MAX_GEOMETRY_VERTICES + 1 }, () => [37.1, 55.1]),
    Array(MAX_GEOMETRY_VERTICES + 1).fill(1)
  ];

  for (const coordinates of oversizedCoordinates) {
    const set = changeSet({ feature: {
      type: 'Feature', geometry: { type: 'LineString', coordinates },
      properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'queue', queue_priority: '1', address: 'Тестовый маршрут', nozzle_direction: 'both', route_start: coordinates[0], route_end: coordinates.at(-1), route_direction: 'start_to_end' }
    } });
    const result = validateChangeSet(set, unreadBoundary);

    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), new RegExp(`не более ${MAX_GEOMETRY_VERTICES} координатных точек`));
  }
});

test('отклоняет полигон, стороны которого выходят за границу САО', () => {
  const start = [37.3568222107043, 55.932847832297185];
  const end = [37.378520597289246, 55.9181242255081];
  const third = [37.357, 55.932];
  const set = changeSet({ feature: {
    type: 'Feature', geometry: { type: 'Polygon', coordinates: [[start, end, third, start]] },
    properties: { district: 'Молжаниновский', author: 'Иванов И.И.', change_type: 'rotor_snow_storage_zone', address: 'Тестовая зона' }
  } });
  set.district = 'Молжаниновский';
  assert.equal(validateChangeSet(set, publishedBoundary).valid, false);
});

test('авторизация, районные права, приёмка и выгрузка работают по API', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  await api.get('/api/me').expect(401);
  const editor = await login(api, 'editor@example.test', editorPassword);
  await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: changeSet({ district: 'Беговой' }) }).expect(403);
  const unassigned = await login(api, 'unassigned@example.test', editorPassword);
  await api.post('/api/submissions').set('Authorization', `Bearer ${unassigned}`).send({ changeSet: changeSet() }).expect(403);
  const submitted = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: changeSet(), originalFilename: 'airport.geojson' }).expect(201);
  await api.get('/api/submissions').set('Authorization', `Bearer ${unassigned}`).expect(403);
  await api.patch(`/api/submissions/${submitted.body.submission.id}`).set('Authorization', `Bearer ${editor}`).send({ status: 'approved' }).expect(403);
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);
  const archive = await api.get('/api/exports/review-archive.zip').set('Authorization', `Bearer ${prefecture}`).buffer(true).parse(binaryParser).expect(200);
  assert.match(archive.headers['content-type'], /application\/zip/);
  assert.match(archive.headers['content-disposition'], /pravki-sao-k-priemke/);
  assert.equal(archive.body.subarray(0, 2).toString(), 'PK');
  assert.match(archive.body.toString('utf8'), /manifest\.json/);
  assert.match(archive.body.toString('utf8'), /районы\/Аэропорт\//);
  const manifest = JSON.parse(unzipEntry(archive.body, 'manifest.json').toString('utf8'));
  assert.equal(manifest.files[0].payload_sha256, payloadHash(changeSet()));
  await api.patch(`/api/submissions/${submitted.body.submission.id}`).set('Authorization', `Bearer ${prefecture}`).send({ status: 'approved', comment: 'Проверено' }).expect(200);
  const exported = await api.get('/api/exports/approved.geojson').set('Authorization', `Bearer ${prefecture}`).expect(200);
  assert.equal(exported.body.review_status, 'approved');
  assert.equal(exported.body.sources.length, 1);
  assert.equal(exported.body.features[0].properties.review_status, 'approved');
});

test('отклоняет неверный маршрут до сохранения', async () => {
  const { api, editorPassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  const invalid = changeSet({ feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.1, 55.1], [39, 57]] }, properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'queue', queue_priority: '1', address: 'За границей' } } });
  const response = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: invalid }).expect(422);
  assert.match(response.body.details.join('\n'), /вне границы САО/);
});

test('возвращает ошибку проверки для повреждённых координат вместо HTTP 500', async () => {
  const { api, editorPassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  const invalid = changeSet({ feature: {
    type: 'Feature', geometry: { type: 'LineString', coordinates: null },
    properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'queue', queue_priority: '1', address: 'Тестовый маршрут', route_start: [37.1, 55.1], route_end: [37.2, 55.2], route_direction: 'start_to_end', nozzle_direction: 'both' }
  } });
  const response = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: invalid }).expect(422);
  assert.match(response.body.details.join('\n'), /минимум две точки/);
});

test('некорректный идентификатор набора отвечает 404, а не HTTP 500', async () => {
  const { api, prefecturePassword } = await fixture();
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);
  await api.patch('/api/submissions/undefined').set('Authorization', `Bearer ${prefecture}`).send({ status: 'approved' }).expect(404);
  await api.patch('/api/submissions/00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${prefecture}`).send({ status: 'approved' }).expect(404);
});

test('фото-метки и снимки доступны только префектуре и удаляются полностью', async () => {
  const { api, reviewerPassword, prefecturePassword } = await fixture();
  const reviewer = await login(api, 'reviewer@example.test', reviewerPassword);
  await api.get('/api/photo-markers').set('Authorization', `Bearer ${reviewer}`).expect(403);
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);
  await api.post('/api/photo-markers').set('Authorization', `Bearer ${prefecture}`).send({ longitude: 39, latitude: 57 }).expect(422);
  const created = await api.post('/api/photo-markers').set('Authorization', `Bearer ${prefecture}`).send({ longitude: 37.2, latitude: 55.2, note: 'До уборки' }).expect(201);
  const markerId = created.body.photoMarker.id;
  await api.patch(`/api/photo-markers/${markerId}`).set('Authorization', `Bearer ${prefecture}`).send({ note: 'После уборки' }).expect(200);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const uploaded = await api.put(`/api/photo-markers/${markerId}/photo`).set('Authorization', `Bearer ${prefecture}`).set('Content-Type', 'image/jpeg').set('X-Photo-Filename', 'inspection.jpg').send(jpeg).expect(200);
  assert.equal(uploaded.body.photoMarker.has_photo, true);
  const downloaded = await api.get(`/api/photo-markers/${markerId}/photo`).set('Authorization', `Bearer ${prefecture}`).buffer(true).parse(binaryParser).expect(200);
  assert.match(downloaded.headers['content-type'], /image\/jpeg/);
  assert.deepEqual(downloaded.body, jpeg);
  await api.delete(`/api/photo-markers/${markerId}/photo`).set('Authorization', `Bearer ${prefecture}`).expect(200);
  await api.get(`/api/photo-markers/${markerId}/photo`).set('Authorization', `Bearer ${prefecture}`).expect(404);
  await api.delete(`/api/photo-markers/${markerId}`).set('Authorization', `Bearer ${prefecture}`).expect(204);
  const listed = await api.get('/api/photo-markers').set('Authorization', `Bearer ${prefecture}`).expect(200);
  assert.equal(listed.body.photoMarkers.length, 0);
});

test('район не допущен к приёмке и выгрузкам, видит только статус своих наборов', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: changeSet(), originalFilename: 'airport.geojson' }).expect(201);

  // Общий список наборов району закрыт в любом виде: ни свой, ни чужой, ни через параметр.
  await api.get('/api/submissions').set('Authorization', `Bearer ${editor}`).expect(403);
  await api.get('/api/submissions?district=Беговой').set('Authorization', `Bearer ${editor}`).expect(403);
  await api.get('/api/submissions?status=submitted').set('Authorization', `Bearer ${editor}`).expect(403);
  // Никаких выгрузок и фото-меток.
  await api.get('/api/exports/review-archive.zip').set('Authorization', `Bearer ${editor}`).expect(403);
  await api.get('/api/exports/approved.geojson').set('Authorization', `Bearer ${editor}`).expect(403);
  await api.get('/api/photo-markers').set('Authorization', `Bearer ${editor}`).expect(403);

  // Но статус своих наборов район видит — и только своего района.
  const mine = await api.get('/api/my-submissions').set('Authorization', `Bearer ${editor}`).expect(200);
  assert.equal(mine.body.district, 'Аэропорт');
  assert.equal(mine.body.submissions.length, 1);
  assert.equal(mine.body.submissions[0].status, 'submitted');
  assert.equal(mine.body.submissions[0].district, 'Аэропорт');
  assert.equal(mine.body.submissions[0].features, 1);

  // Набор на доработке район открывает заново — с объектами; по остальным
  // статусам объектов в ответе нет, хватает счётчика.
  const prefectureForReject = await login(api, 'prefecture@example.test', prefecturePassword);
  const submittedId = mine.body.submissions[0].id;
  assert.equal(mine.body.submissions[0].change_set, undefined);
  await api.patch(`/api/submissions/${submittedId}`).set('Authorization', `Bearer ${prefectureForReject}`)
    .send({ status: 'rejected', comment: 'Уточните направление сопла' }).expect(200);
  const returned = await api.get('/api/my-submissions').set('Authorization', `Bearer ${editor}`).expect(200);
  assert.equal(returned.body.submissions[0].status, 'rejected');
  assert.equal(returned.body.submissions[0].review_comment, 'Уточните направление сопла');
  assert.equal(returned.body.submissions[0].change_set.features.length, 1);
  assert.equal(returned.body.submissions[0].change_set.district, 'Аэропорт');

  // Префектура работает с приёмкой и выгрузками, но не с районной ручкой статуса.
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);
  const own = await api.get('/api/submissions').set('Authorization', `Bearer ${prefecture}`).expect(200);
  assert.equal(own.body.submissions.length, 1);
  const other = await api.get('/api/submissions?district=Беговой').set('Authorization', `Bearer ${prefecture}`).expect(200);
  assert.equal(other.body.submissions.length, 0);
  await api.get('/api/my-submissions').set('Authorization', `Bearer ${prefecture}`).expect(403);
});

test('счётчик приёмки отдаётся одними числами и закрыт району', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  await api.get('/api/submissions/stats').set('Authorization', `Bearer ${editor}`).expect(403);

  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);
  const stats = await api.get('/api/submissions/stats').set('Authorization', `Bearer ${prefecture}`).expect(200);

  assert.deepEqual(stats.body.sets, { total: 3, submitted: 1, approved: 1, rejected: 1 });
  assert.deepEqual(stats.body.objects, { total: 9, submitted: 4, approved: 4, rejected: 1 });
  assert.equal(stats.body.lastDistrict, 'Аэропорт');
  assert.equal(stats.body.lastSubmittedAt, '2026-09-08T10:01:00.000Z');
  assert.ok(stats.body.checkedAt, 'время снятия счётчика');
  // Наборов в ответе нет: иначе ручка тянула бы change_set каждого набора, а её
  // опрашивают каждые полминуты.
  assert.equal(stats.body.submissions, undefined);
});

test('отчёт по маршрутам доступен префектуре и закрыт району', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  await api.get('/api/reports/routes').set('Authorization', `Bearer ${editor}`).expect(403);

  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);
  const report = await api.get('/api/reports/routes').set('Authorization', `Bearer ${prefecture}`).expect(200);
  assert.match(report.headers['content-type'], /application\/json/);
  assert.equal(report.body.districts[0].district, 'Аэропорт');
  assert.equal(report.body.districts[0].routes, 2);
  assert.equal(report.body.districts[0].zones, 1);
  assert.equal(report.body.totals.routes, 2);
  assert.match(report.body.csvName, /^odh-routes-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('CSV отчёта по маршрутам начинается с BOM и тоже закрыт району', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  await api.get('/api/reports/routes.csv').set('Authorization', `Bearer ${editor}`).expect(403);

  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);
  const csv = await api.get('/api/reports/routes.csv').set('Authorization', `Bearer ${prefecture}`).buffer(true).parse(binaryParser).expect(200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.headers['content-type'], /charset=utf-8/);
  assert.match(csv.headers['content-disposition'], /odh-routes-\d{4}-\d{2}-\d{2}\.csv/);
  assert.equal(csv.body.subarray(0, 3).toString('hex'), 'efbbbf', 'файл начинается с BOM');
  assert.match(csv.body.toString('utf8'), /Район;Маршрутов;Зон;Точек;На приёмке;Утверждено;Отклонено;Последняя отправка/);
});

test('упразднённая роль reviewer больше не имеет доступа ни к приёмке, ни к выгрузкам', async () => {
  const { api, reviewerPassword } = await fixture();
  const legacy = await login(api, 'reviewer@example.test', reviewerPassword);
  await api.get('/api/submissions').set('Authorization', `Bearer ${legacy}`).expect(403);
  await api.patch(`/api/submissions/${fakeId('5b', 1)}`).set('Authorization', `Bearer ${legacy}`).send({ status: 'approved' }).expect(403);
  await api.get('/api/exports/review-archive.zip').set('Authorization', `Bearer ${legacy}`).expect(403);
  await api.get('/api/exports/approved.geojson').set('Authorization', `Bearer ${legacy}`).expect(403);
  await api.get('/api/photo-markers').set('Authorization', `Bearer ${legacy}`).expect(403);
});

test('вход без пароля или с неверным типом пароля отвечает 401, а не HTTP 500', async () => {
  const { api, editorPassword } = await fixture();

  // scrypt принимает только строку: тело запроса произвольное, поэтому тип
  // проверяется до хеширования, а не падает с 500 внутри фреймворка.
  await api.post('/api/auth/login').send({ email: 'editor@example.test' }).expect(401);
  await api.post('/api/auth/login').send({ email: 'editor@example.test', password: 12345678 }).expect(401);
  await api.post('/api/auth/login').send({ email: 'editor@example.test', password: null }).expect(401);
  await api.post('/api/auth/login').send({ email: 'editor@example.test', password: { any: 'object' } }).expect(401);
  // Верный пароль по-прежнему пускает.
  await login(api, 'editor@example.test', editorPassword);
});

test('повреждённый JSON и слишком большое тело отвечают 400 и 413, а не HTTP 500', async () => {
  const { api, editorPassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);

  const broken = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`)
    .set('Content-Type', 'application/json').send('{not json').expect(400);
  assert.match(broken.body.error, /корректным JSON/);

  // Лимит тела — 6 МБ из express.json; превышение — ошибка клиента (413).
  const oversized = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`)
    .send({ changeSet: changeSet(), originalFilename: 'x'.repeat(7 * 1024 * 1024) }).expect(413);
  assert.match(oversized.body.error, /слишком большое/);
});

test('пустой комментарий приёмки принимается, а неверный тип получает понятную ошибку', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  const submitted = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`)
    .send({ changeSet: changeSet(), originalFilename: 'airport.geojson' }).expect(201);
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);

  // null — это «без комментария», а не «слишком длинный».
  await api.patch(`/api/submissions/${submitted.body.submission.id}`).set('Authorization', `Bearer ${prefecture}`)
    .send({ status: 'approved', comment: null }).expect(200);

  const wrongType = await api.patch(`/api/submissions/${submitted.body.submission.id}`).set('Authorization', `Bearer ${prefecture}`)
    .send({ status: 'approved', comment: 12345 }).expect(400);
  assert.match(wrongType.body.error, /должен быть строкой/);
});

test('повреждённый набор правок отвечает 4xx и не оседает в базе', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);

  const base = { type: 'FeatureCollection', change_set_version: 'district_change_set_v2', district: 'Аэропорт', author: 'Иванов И.И.' };
  const props = (over = {}) => ({
    district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'queue', queue_priority: '1', address: 'Тестовый маршрут',
    nozzle_direction: 'both', route_start: [37.1, 55.1], route_end: [37.2, 55.2], route_direction: 'start_to_end', ...over
  });
  const longRoute = Array.from({ length: MAX_GEOMETRY_VERTICES + 1 }, (_, index) => [37.1 + index / 1e6, 55.1]);
  const cases = [
    ['changeSet = null', { changeSet: null }],
    ['changeSet — массив', { changeSet: [] }],
    ['changeSet — строка', { changeSet: 'FeatureCollection' }],
    ['нет features', { changeSet: { ...base } }],
    ['features из не-объектов', { changeSet: { ...base, features: [null, 0, 'x', {}, { type: 'Feature' }] } }],
    ['объект без properties', { changeSet: { ...base, features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.1, 55.1], [37.2, 55.2]] } }] } }],
    ['неизвестный change_type', { changeSet: { ...base, features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.1, 55.1], [37.2, 55.2]] }, properties: props({ change_type: 'alien_type' }) }] } }],
    ['координаты вне САО', { changeSet: { ...base, features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { district: 'Аэропорт', author: 'Иванов И.И.', change_type: 'pgm', address: 'вне округа' } }] } }],
    ['объектов больше 500', { changeSet: { ...base, features: Array.from({ length: 501 }, () => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[37.1, 55.1], [37.2, 55.2]] }, properties: props() })) } }],
    ['вершин больше предела', { changeSet: { ...base, features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: longRoute }, properties: props({ route_start: longRoute[0], route_end: longRoute.at(-1) }) }] } }]
  ];

  for (const [label, payload] of cases) {
    const response = await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send(payload);
    assert.ok(response.status >= 400 && response.status < 500, `${label}: ожидали 4xx, получили ${response.status}`);
  }

  // Ни один повреждённый набор не сохранился: в списке пусто.
  const stored = await api.get('/api/submissions').set('Authorization', `Bearer ${prefecture}`).expect(200);
  assert.equal(stored.body.submissions.length, 0, 'повреждённые наборы не осели в базе');
});

test('районный редактор не читает чужие районы и не действует вне своего', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);

  // 1. Все привилегированные ручки закрыты для района — включая отчёты и выгрузки.
  const forbidden = [
    ['get', '/api/submissions'],
    ['get', '/api/submissions?district=Беговой'],
    ['get', '/api/submissions?status=approved'],
    ['patch', `/api/submissions/${fakeId('5b', 1)}`],
    ['get', '/api/exports/approved.geojson'],
    ['get', '/api/exports/review-archive.zip'],
    ['get', '/api/reports/routes'],
    ['get', '/api/reports/routes.csv'],
    ['get', '/api/photo-markers'],
    ['post', '/api/photo-markers'],
    ['patch', `/api/photo-markers/${fakeId('f0', 1)}`],
    ['put', `/api/photo-markers/${fakeId('f0', 1)}/photo`],
    ['get', `/api/photo-markers/${fakeId('f0', 1)}/photo`],
    ['delete', `/api/photo-markers/${fakeId('f0', 1)}/photo`],
    ['delete', `/api/photo-markers/${fakeId('f0', 1)}`]
  ];
  for (const [method, url] of forbidden) {
    let call = api[method](url).set('Authorization', `Bearer ${editor}`);
    if (method !== 'get') call = call.send({ status: 'approved', note: 'n', longitude: 37.5, latitude: 55.5 });
    const response = await call;
    assert.equal(response.status, 403, `${method.toUpperCase()} ${url} должен быть закрыт району`);
  }

  // 2. Действие вне своего района отбито, в своём — принято.
  await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: changeSet({ district: 'Беговой' }) }).expect(403);
  await api.post('/api/submissions').set('Authorization', `Bearer ${editor}`).send({ changeSet: changeSet() }).expect(201);

  // 3. Чужой район, отправленный префектурой, районному редактору не виден.
  await api.post('/api/submissions').set('Authorization', `Bearer ${prefecture}`).send({ changeSet: changeSet({ district: 'Беговой', author: 'Петров П.П.' }) }).expect(201);
  const mine = await api.get('/api/my-submissions').set('Authorization', `Bearer ${editor}`).expect(200);
  assert.equal(mine.body.district, 'Аэропорт');
  assert.deepEqual(mine.body.submissions.map((item) => item.district), ['Аэропорт']);
});

test('ни одна ручка не отвечает 5xx на повреждённое тело запроса', async () => {
  const { api, editorPassword, prefecturePassword } = await fixture();
  const editor = await login(api, 'editor@example.test', editorPassword);
  const prefecture = await login(api, 'prefecture@example.test', prefecturePassword);

  // Тела — как их может прислать сломанный клиент: null, пусто, не тот тип, чужие поля.
  const bodies = [
    undefined, null, {}, { changeSet: null }, { changeSet: {} },
    { changeSet: { type: 'FeatureCollection', change_set_version: 'district_change_set_v2', district: 'Аэропорт', author: 'A', features: [null, 0, 'x', {}, { type: 'Feature' }] } },
    { status: 'approved' }, { status: 'nope' }, { status: 'approved', comment: null },
    { note: 5 }, { note: 'x'.repeat(3000) }, { longitude: 'a', latitude: 'b' },
    { longitude: 37.2, latitude: 55.2, note: 'n' }, { email: 'editor@example.test' }, { password: 5 }
  ];
  const endpoints = [
    ['post', '/api/submissions', editor],
    ['post', '/api/submissions', prefecture],
    ['patch', `/api/submissions/${fakeId('5b', 1)}`, prefecture],
    ['patch', '/api/submissions/not-a-uuid', prefecture],
    ['get', '/api/submissions', prefecture],
    ['get', '/api/submissions?status=bad', prefecture],
    ['get', '/api/my-submissions', editor],
    ['post', '/api/photo-markers', prefecture],
    ['patch', `/api/photo-markers/${fakeId('f0', 1)}`, prefecture],
    ['put', `/api/photo-markers/${fakeId('f0', 1)}/photo`, prefecture],
    ['get', '/api/exports/approved.geojson', prefecture],
    ['get', '/api/exports/review-archive.zip', prefecture],
    ['get', '/api/reports/routes', prefecture],
    ['get', '/api/reports/routes.csv', prefecture],
    ['post', '/api/auth/login', null]
  ];

  for (const [method, url, token] of endpoints) {
    for (const body of bodies) {
      let call = api[method](url);
      if (token) call = call.set('Authorization', `Bearer ${token}`);
      if (method !== 'get' && body !== undefined) call = call.send(body);
      const response = await call;
      assert.ok(response.status < 500, `${method.toUpperCase()} ${url} с телом ${JSON.stringify(body)?.slice(0, 40)} ответил ${response.status}`);
    }
  }
});
