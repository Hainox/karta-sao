// Слоты фото по заданию для карты ТПУ и парковок и проверка их префектурой.
// У объекта столько слотов, сколько фото требуется по каталогу (без числа — один).
// Район (или АвД) загружает фото в слот своего объекта; префектура принимает фото
// или отклоняет с комментарием. Отклонённое фото освобождает слот, комментарий
// остаётся у слота, пока район не загрузит новое фото.
import crypto from 'node:crypto';
import express from 'express';
import { readFileSync } from 'node:fs';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';

export const SLOT_DATASET = 'sao_tpu_parking';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATALOG = JSON.parse(readFileSync(new URL('./tpu-objects.json', import.meta.url), 'utf8'));
export const SLOT_OBJECTS = new Map(CATALOG.map((o) => [o.id, o]));
const SLOT_COLUMNS = 'id, object_key, slot, district, photo_mime_type, photo_filename, photo_size, uploaded_by, uploaded_at, status, review_comment, reviewed_by, reviewed_at';

export const SLOT_STATUS_LABELS = {
  empty: 'Нет фото', progress: 'В работе', review: 'На проверке', rework: 'На доработке', closed: 'Закрыта',
};

/** Сколько фото требуется по объекту: число из каталога, без него — одно. */
export function requiredPhotos(object) {
  const value = Number(object?.photos);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

const time = (row) => new Date(row.reviewed_at || row.uploaded_at || 0).getTime();

/**
 * Состояние объекта по фото его слотов. В слоте действует фото на проверке или принятое;
 * если действующего нет, а последнее фото отклонено — слот свободен и несёт комментарий.
 * Хоть один такой слот — объект «На доработке»; все слоты приняты — «Закрыта».
 */
export function slotState(required, rows) {
  const slots = [];
  for (let slot = 1; slot <= required; slot += 1) {
    const own = rows.filter((row) => Number(row.slot) === slot);
    const photo = own.find((row) => row.status === 'pending' || row.status === 'accepted') || null;
    const rejected = photo ? null : own.filter((row) => row.status === 'rejected').sort((a, b) => time(b) - time(a))[0] || null;
    slots.push({ slot, photo, rejected });
  }
  const accepted = slots.filter((s) => s.photo?.status === 'accepted').length;
  const filled = slots.filter((s) => s.photo).length;
  let status = 'empty';
  if (slots.some((s) => s.rejected)) status = 'rework';
  else if (accepted === required) status = 'closed';
  else if (filled === required) status = 'review';
  else if (filled) status = 'progress';
  return { required, filled, accepted, status, label: SLOT_STATUS_LABELS[status], slots };
}

/** Сводка по всем объектам каталога (без фото и комментариев) — для цвета маркеров. */
export function slotSummary(rows, objects = SLOT_OBJECTS) {
  const byObject = new Map();
  for (const row of rows) {
    if (!byObject.has(row.object_key)) byObject.set(row.object_key, []);
    byObject.get(row.object_key).push(row);
  }
  const summary = [];
  for (const [key, own] of byObject) {
    const object = objects.get(key);
    if (!object) continue;
    const { required, filled, accepted, status } = slotState(requiredPhotos(object), own);
    summary.push({ object_key: key, required, filled, accepted, status });
  }
  return summary;
}

const objectInfo = (key, object) => ({ id: key, label: object.label, kind: object.kind, type: object.type || (object.kind === 'tpu' ? 'ТПУ' : 'Парковка'), group: object.group, required: requiredPhotos(object) });

/**
 * Очередь кабинета приёмки: фото на проверке (старые сверху), слоты на доработке
 * с комментарием и число объектов по статусам — по всем объектам каталога.
 */
export function slotQueue(rows, objects = SLOT_OBJECTS) {
  const byObject = new Map();
  for (const row of rows) {
    if (!objects.has(row.object_key)) continue;
    if (!byObject.has(row.object_key)) byObject.set(row.object_key, []);
    byObject.get(row.object_key).push(row);
  }
  const pending = [];
  const rework = [];
  const counts = { empty: objects.size - byObject.size, progress: 0, review: 0, rework: 0, closed: 0 };
  for (const [key, own] of byObject) {
    const object = objects.get(key);
    const state = slotState(requiredPhotos(object), own);
    counts[state.status] += 1;
    for (const slot of state.slots) {
      if (slot.photo?.status === 'pending') pending.push({ ...slot.photo, object: objectInfo(key, object) });
      if (slot.rejected) rework.push({ ...slot.rejected, object: objectInfo(key, object) });
    }
  }
  const time = (row) => new Date(row.uploaded_at).getTime();
  pending.sort((a, b) => time(a) - time(b));
  rework.sort((a, b) => time(b) - time(a));
  return { counts, pending, rework };
}

export function validateReview(body) {
  const decision = body?.decision;
  const comment = typeof body?.comment === 'string' ? body.comment.trim() : '';
  if (!['accepted', 'rejected'].includes(decision)) return { valid: false, error: 'Укажите решение: принять или отклонить.' };
  if (decision === 'rejected' && !comment) return { valid: false, error: 'Напишите, что не так и что исправить.' };
  if (comment.length > 2000) return { valid: false, error: 'Комментарий не длиннее 2 000 символов.' };
  return { valid: true, value: { decision, comment } };
}

/** Открытый маршрут без входа: статусы объектов для раскраски карты. */
export function mountPublicSlotRoutes(router, { repository }) {
  router.get('/slots/public', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ objects: slotSummary(await repository.listSlotPhotos({ datasetId: SLOT_DATASET })) });
    } catch (error) { next(error); }
  });
}

/** Маршруты под учётной записью: регистрируются до маршрутов «/:id» точек съёмки. */
export function mountSlotRoutes(router, { repository, districtFor }) {
  const prefecture = (req, res, next) => req.user.role === 'prefecture_admin' ? next() : res.status(403).json({ error: 'Фото проверяет префектура.' });
  // Объект из каталога и право на него: районная учётка (и АвД) — только свои объекты.
  const accessObject = (req, res, next) => {
    const object = SLOT_OBJECTS.get(req.params.objectKey);
    if (!object) return res.status(404).json({ error: 'Объект не найден.' });
    const district = districtFor(req);
    if (district && object.group !== district) return res.status(404).json({ error: 'Объект не найден.' });
    req.slotObject = object;
    next();
  };
  const accessPhoto = async (req, res, next) => {
    try {
      if (!UUID.test(req.params.photoId)) return res.status(400).json({ error: 'Некорректный идентификатор фото.' });
      req.slotPhoto = await repository.getSlotPhoto({ id: req.params.photoId, district: districtFor(req) });
      if (!req.slotPhoto) return res.status(404).json({ error: 'Фото не найдено.' });
      next();
    } catch (error) { next(error); }
  };

  // Свод Excel по фото в слотах — только префектуре.
  router.get('/slots/report.xlsx', prefecture, async (req, res, next) => {
    try {
      const { summarizeSlots, buildSlotReport } = await import('./slot-report.js');
      const generatedAt = new Date();
      const book = await buildSlotReport(summarizeSlots({ rows: await repository.listSlotPhotos({ datasetId: SLOT_DATASET }), generatedAt }));
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Svod_foto_TPU_parkovki_${generatedAt.toISOString().slice(0, 10)}.xlsx"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(book);
    } catch (error) { next(error); }
  });
  // Кабинет приёмки: очередь фото на проверке и слоты на доработке по всем объектам.
  router.get('/slots/queue', prefecture, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(slotQueue(await repository.listSlotPhotos({ datasetId: SLOT_DATASET })));
    } catch (error) { next(error); }
  });
  router.get('/slots/objects/:objectKey', accessObject, async (req, res, next) => {
    try {
      const rows = await repository.listSlotPhotos({ datasetId: SLOT_DATASET, objectKey: req.params.objectKey });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ objectKey: req.params.objectKey, ...slotState(requiredPhotos(req.slotObject), rows) });
    } catch (error) { next(error); }
  });
  router.put('/slots/objects/:objectKey/:slot/photo',
    (req, res, next) => req.user.role === 'reviewer' ? res.status(403).json({ error: 'Фото загружает район, АвД или префектура.' }) : next(),
    accessObject,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }),
    async (req, res, next) => {
      try {
        const slot = Number(req.params.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > requiredPhotos(req.slotObject)) return res.status(400).json({ error: 'Такого слота у объекта нет.' });
        const validation = validatePhotoUpload(req.body, req.get('content-type'));
        if (!validation.valid) return res.status(422).json({ error: validation.error });
        const photo = await repository.addSlotPhoto({
          datasetId: SLOT_DATASET, objectKey: req.params.objectKey, slot, district: req.slotObject.group,
          bytes: req.body, mimeType: validation.mimeType, filename: safePhotoFilename(req.get('x-photo-filename')), actorId: req.user.sub,
        });
        res.status(201).json({ photo });
      } catch (error) { next(error); }
    });
  router.get('/slots/photos/:photoId', accessPhoto, async (req, res, next) => {
    try {
      const photo = await repository.getSlotPhotoBytes({ id: req.params.photoId });
      if (!photo) return res.status(404).json({ error: 'Фото не найдено.' });
      res.setHeader('Cache-Control', 'private, no-store');
      res.type(photo.photo_mime_type).send(photo.photo_bytes);
    } catch (error) { next(error); }
  });
  router.post('/slots/photos/:photoId/review', prefecture, accessPhoto, async (req, res, next) => {
    try {
      const validation = validateReview(req.body);
      if (!validation.valid) return res.status(422).json({ error: validation.error });
      const photo = await repository.reviewSlotPhoto({ id: req.params.photoId, ...validation.value, actorId: req.user.sub });
      if (!photo) return res.status(409).json({ error: 'Фото уже отклонено. Дождитесь нового фото в этом слоте.' });
      res.json({ photo });
    } catch (error) { next(error); }
  });
}

/** Методы хранилища слотов; write — общая транзакция с записью в журнал аудита. */
export function createSlotRepository(pool, write) {
  return {
    async listSlotPhotos({ datasetId, objectKey = null, district = null }) {
      const { rows } = await pool.query(`SELECT ${SLOT_COLUMNS} FROM object_slot_photos WHERE dataset_id = $1 AND ($2::text IS NULL OR object_key = $2) AND ($3::text IS NULL OR district = $3) ORDER BY uploaded_at, id`, [datasetId, objectKey, district]);
      return rows;
    },
    async getSlotPhoto({ id, district }) {
      const { rows } = await pool.query(`SELECT ${SLOT_COLUMNS} FROM object_slot_photos WHERE id = $1 AND ($2::text IS NULL OR district = $2)`, [id, district || null]);
      return rows[0] || null;
    },
    async getSlotPhotoBytes({ id }) {
      const { rows } = await pool.query('SELECT photo_bytes, photo_mime_type FROM object_slot_photos WHERE id = $1', [id]);
      return rows[0] || null;
    },
    addSlotPhoto({ datasetId, objectKey, slot, district, bytes, mimeType, filename, actorId }) {
      return write(actorId, 'object_slot_photo_uploaded', { objectKey, slot }, async (client) => {
        try {
          const { rows } = await client.query(`INSERT INTO object_slot_photos (id, dataset_id, object_key, slot, district, photo_bytes, photo_mime_type, photo_filename, photo_size, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${SLOT_COLUMNS}`, [crypto.randomUUID(), datasetId, objectKey, slot, district, bytes, mimeType, filename, bytes.length, actorId]);
          return rows[0];
        } catch (error) {
          // Уникальный индекс: в слоте уже лежит фото на проверке или принятое.
          if (error.code === '23505') throw Object.assign(new Error('Слот уже занят. Обновите карточку объекта.'), { status: 409 });
          throw error;
        }
      });
    },
    reviewSlotPhoto({ id, decision, comment, actorId }) {
      return write(actorId, 'object_slot_photo_reviewed', { photoId: id, decision }, async (client) => {
        // Отклонённое фото уже освободило слот — повторно его не проверяем.
        const { rows } = await client.query(`UPDATE object_slot_photos SET status = $2, review_comment = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 AND status <> 'rejected' RETURNING ${SLOT_COLUMNS}`, [id, decision, comment, actorId]);
        return rows[0] || null;
      });
    },
  };
}
