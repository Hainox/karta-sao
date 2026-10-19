// Слоты фото по заданию на карте ТПУ и парковок и их проверка префектурой.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { createObjectPhotoPointsRouter } from '../src/tpu-points/object-photo-points.js';
import { requiredPhotos, slotQueue, slotState, SLOT_OBJECTS, validateReview } from '../src/tpu-points/object-slots.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
// Объекты каталога: карман Коптево на 11 фото, ТПУ без числа (один слот), объект АвД.
const POCKET = 'parking:1140280893';
const TPU = 'tpu:800905601';
const AVD = [...SLOT_OBJECTS.values()].find((o) => o.group === 'АвД САО' && o.photos > 1).id;

const row = (slot, status, extra = {}) => ({ id: crypto.randomUUID(), slot, status, review_comment: '', uploaded_at: new Date().toISOString(), ...extra });

test('число слотов берётся из каталога, без числа — один слот', () => {
  assert.equal(requiredPhotos(SLOT_OBJECTS.get(POCKET)), 11);
  assert.equal(requiredPhotos(SLOT_OBJECTS.get(TPU)), 1);
  assert.equal(requiredPhotos({}), 1);
});

test('объект закрыт, только когда приняты все требуемые фото', () => {
  assert.equal(slotState(2, []).status, 'empty');
  assert.equal(slotState(2, [row(1, 'pending')]).status, 'progress');
  assert.equal(slotState(2, [row(1, 'pending'), row(2, 'accepted')]).status, 'review');
  assert.equal(slotState(2, [row(1, 'accepted'), row(2, 'accepted')]).status, 'closed');
  assert.equal(slotState(2, [row(1, 'accepted'), row(2, 'accepted')]).label, 'Закрыта');
});

test('отклонённое фото освобождает слот, а объект уходит на доработку с комментарием', () => {
  const state = slotState(2, [row(1, 'accepted'), row(2, 'rejected', { review_comment: 'Снимок размыт, переснимите с другой стороны' })]);
  assert.equal(state.status, 'rework');
  assert.equal(state.label, 'На доработке');
  assert.equal(state.slots[1].photo, null, 'слот свободен для нового фото');
  assert.equal(state.slots[1].rejected.review_comment, 'Снимок размыт, переснимите с другой стороны');
  const fixed = slotState(2, [row(1, 'accepted'), row(2, 'rejected'), row(2, 'pending')]);
  assert.equal(fixed.status, 'review', 'после нового фото объект снова на проверке');
  assert.equal(fixed.slots[1].rejected, null);
});

test('отклонить фото можно только с комментарием', () => {
  assert.equal(validateReview({ decision: 'rejected', comment: '  ' }).valid, false);
  assert.equal(validateReview({ decision: 'rejected', comment: 'Не видно разметку' }).valid, true);
  assert.equal(validateReview({ decision: 'accepted' }).valid, true);
  assert.equal(validateReview({ decision: 'maybe' }).valid, false);
});

async function serve(user, run) {
  const photos = [];
  const repository = {
    async listObjectPhotoPoints() { return []; },
    async listSlotPhotos({ objectKey }) { return photos.filter((p) => !objectKey || p.object_key === objectKey); },
    async getSlotPhoto({ id, district }) { return photos.find((p) => p.id === id && (!district || p.district === district)) || null; },
    async getSlotPhotoBytes({ id }) { const p = photos.find((x) => x.id === id); return p && { photo_bytes: JPEG, photo_mime_type: 'image/jpeg' }; },
    async addSlotPhoto(input) {
      if (photos.some((p) => p.object_key === input.objectKey && p.slot === input.slot && p.status !== 'rejected')) throw Object.assign(new Error('Слот уже занят.'), { status: 409 });
      const photo = { id: crypto.randomUUID(), object_key: input.objectKey, slot: input.slot, district: input.district, status: 'pending', review_comment: '', uploaded_at: new Date().toISOString() };
      photos.push(photo); return photo;
    },
    async reviewSlotPhoto({ id, decision, comment }) {
      const photo = photos.find((p) => p.id === id && p.status !== 'rejected');
      if (!photo) return null;
      Object.assign(photo, { status: decision, review_comment: comment, reviewed_at: new Date().toISOString() });
      return photo;
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/object-photo-points', createObjectPhotoPointsRouter({
    repository,
    authenticate: (req, _res, next) => { req.user = { ...user, sub: 'user' }; next(); },
    boundary: { type: 'FeatureCollection', features: [] },
  }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/object-photo-points`;
  try { return await run(base, photos); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const upload = (base, key, slot) => fetch(`${base}/slots/objects/${encodeURIComponent(key)}/${slot}/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Filename': 'kadr.jpg' }, body: JPEG });
const review = (base, id, body) => fetch(`${base}/slots/photos/${id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('район загружает фото в слоты своего объекта, но не чужого', async () => {
  await serve({ role: 'district_editor', district: 'Коптево' }, async (base, photos) => {
    assert.equal((await upload(base, POCKET, 1)).status, 201);
    assert.equal(photos[0].district, 'Коптево');
    assert.equal((await upload(base, POCKET, 1)).status, 409, 'занятый слот не перезаписывается');
    assert.equal((await upload(base, POCKET, 12)).status, 400, 'у кармана 11 слотов');
    assert.equal((await upload(base, TPU, 1)).status, 404, 'ТПУ АвД району недоступен');
    const state = await (await fetch(`${base}/slots/objects/${encodeURIComponent(POCKET)}`)).json();
    assert.equal(state.required, 11);
    assert.equal(state.status, 'progress');
    assert.equal((await review(base, photos[0].id, { decision: 'accepted' })).status, 403, 'проверяет только префектура');
  });
});

test('АвД загружает фото в слоты объектов на своём балансе', async () => {
  await serve({ role: 'district_editor', district: 'АвД САО' }, async (base) => {
    assert.equal((await upload(base, AVD, 2)).status, 201);
    assert.equal((await upload(base, POCKET, 1)).status, 404);
  });
});

test('префектура отклоняет фото с комментарием: слот свободен, объект на доработке', async () => {
  await serve({ role: 'prefecture_admin' }, async (base, photos) => {
    await upload(base, TPU, 1);
    assert.equal((await review(base, photos[0].id, { decision: 'rejected' })).status, 422, 'без комментария нельзя');
    assert.equal((await review(base, photos[0].id, { decision: 'rejected', comment: 'Не видно табличку ТПУ' })).status, 200);
    let state = await (await fetch(`${base}/slots/objects/${encodeURIComponent(TPU)}`)).json();
    assert.equal(state.status, 'rework');
    assert.equal(state.slots[0].rejected.review_comment, 'Не видно табличку ТПУ');
    assert.equal((await upload(base, TPU, 1)).status, 201, 'в освобождённый слот загружается новое фото');
    assert.equal((await review(base, photos[1].id, { decision: 'accepted' })).status, 200);
    state = await (await fetch(`${base}/slots/objects/${encodeURIComponent(TPU)}`)).json();
    assert.equal(state.status, 'closed');
    const summary = await (await fetch(`${base}/slots/public`)).json();
    assert.deepEqual(summary.objects, [{ object_key: TPU, required: 1, filled: 1, accepted: 1, status: 'closed' }]);
  });
});

test('очередь кабинета приёмки: фото на проверке и слоты на доработке по всем объектам', () => {
  const rows = [
    { ...row(1, 'pending'), object_key: POCKET, uploaded_at: '2026-10-19T10:00:00Z' },
    { ...row(2, 'rejected', { review_comment: 'Темно' }), object_key: POCKET, uploaded_at: '2026-10-19T09:00:00Z' },
    { ...row(1, 'accepted'), object_key: TPU, uploaded_at: '2026-10-19T08:00:00Z' },
    { ...row(1, 'pending'), object_key: 'tpu:нет-в-каталоге' },
  ];
  const queue = slotQueue(rows);
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.pending[0].object.id, POCKET);
  assert.equal(queue.pending[0].object.type, 'Парковочный карман');
  assert.equal(queue.pending[0].object.required, 11);
  assert.deepEqual(queue.rework.map((r) => r.review_comment), ['Темно']);
  assert.equal(queue.counts.rework, 1);
  assert.equal(queue.counts.closed, 1);
  assert.equal(queue.counts.empty, SLOT_OBJECTS.size - 2);
});

test('очередь кабинета приёмки доступна только префектуре', async () => {
  await serve({ role: 'district_editor', district: 'Коптево' }, async (base) => {
    assert.equal((await fetch(`${base}/slots/queue`)).status, 403);
  });
  await serve({ role: 'prefecture_admin' }, async (base) => {
    await upload(base, TPU, 1);
    const queue = await (await fetch(`${base}/slots/queue`)).json();
    assert.equal(queue.pending.length, 1);
    assert.equal(queue.pending[0].object.label, SLOT_OBJECTS.get(TPU).label);
  });
});

test('свод Excel по слотам: районы, виды объектов, объекты и доработка', async () => {
  const { summarizeSlots, buildSlotReport } = await import('../src/tpu-points/slot-report.js');
  const ExcelJS = (await import('exceljs')).default;
  const rows = [
    { ...row(1, 'accepted'), object_key: TPU },
    { ...row(1, 'accepted'), object_key: POCKET },
    { ...row(2, 'pending'), object_key: POCKET },
    { ...row(3, 'rejected', { review_comment: 'Не видно разметку', reviewed_at: '2026-10-19T10:00:00Z' }), object_key: POCKET },
  ];
  const summary = summarizeSlots({ rows, generatedAt: new Date('2026-10-19T12:00:00Z') });
  assert.equal(summary.objectRows.length, SLOT_OBJECTS.size);
  assert.equal(summary.total.accepted, 2);
  assert.equal(summary.total.pending, 1);
  assert.equal(summary.total.rework, 1);
  assert.equal(summary.total.closed, 1, 'ТПУ с одним слотом закрыт');
  assert.equal(summary.total.required, [...SLOT_OBJECTS.values()].reduce((s, o) => s + requiredPhotos(o), 0));
  const koptevo = summary.groupRows.find((g) => g.label === 'Коптево');
  assert.equal(koptevo.accepted, 1);
  assert.equal(koptevo.rework, 1);
  assert.deepEqual(summary.kindRows.map((k) => k.label), ['ТПУ', 'Автомобильные парковки', 'Парковочные карманы']);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildSlotReport(summary));
  assert.deepEqual(book.worksheets.map((s) => s.name), ['Свод по районам', 'Объекты', 'На доработке']);
  assert.equal(book.getWorksheet('Объекты').rowCount, SLOT_OBJECTS.size + 1);
  assert.equal(book.getWorksheet('На доработке').getRow(2).getCell(4).value, 'Не видно разметку');
  const overview = book.getWorksheet('Свод по районам');
  const totalRow = overview.getColumn(1).values.indexOf('Итого по САО');
  assert.equal(overview.getRow(totalRow).getCell(5).value, 2);
});

test('свод Excel по слотам скачивает только префектура', async () => {
  await serve({ role: 'district_editor', district: 'Коптево' }, async (base) => {
    assert.equal((await fetch(`${base}/slots/report.xlsx`)).status, 403);
  });
  await serve({ role: 'prefecture_admin' }, async (base) => {
    await upload(base, TPU, 1);
    const response = await fetch(`${base}/slots/report.xlsx`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /Svod_foto_TPU_parkovki_/);
  });
});
