// Приёмка фото районных точек съёмки: у точки один слот, префектура принимает
// снимок целиком («Принять объект») или возвращает району с комментарием.
// Отклонённое фото освобождает слот, но остаётся историей: район видит, что
// исправить. Кабинет ведёт по точкам бесконечный поток: проверил — открыт
// следующий, пока очередь не кончится.
import express from 'express';
import { validateReview } from './object-slots.js';

export const DISTRICT_DATASET = 'sao_district_photo_points';

export const POINT_STATE_LABELS = {
  empty: 'Нет фото', pending: 'На проверке', accepted: 'Принято', rework: 'На доработке',
};

/**
 * Состояние точки из строки выборки (плоской, как приходит из SQL): активное
 * фото побеждает отклонённое — пересдача не возвращает точку в «доработку».
 */
export function pointState(row) {
  const photo = row.photo_status ? {
    id: row.photo_id,
    status: row.photo_status,
    uploaded_at: row.uploaded_at,
    photo_filename: row.photo_filename,
  } : null;
  const rejected = (row.rejected_comment || row.rejected_at || row.rejected_photo_id) ? {
    id: row.rejected_photo_id || null,
    comment: row.rejected_comment || '',
    reviewed_at: row.rejected_at || null,
    uploaded_at: row.rejected_uploaded_at || null,
    photo_filename: row.rejected_photo_filename || null,
  } : null;
  if (photo) return { status: photo.status, photo, rejected };
  if (rejected) return { status: 'rework', photo: null, rejected };
  return { status: 'empty', photo: null, rejected: null };
}

/**
 * Очередь кабинета приёмки из строк выборки по всем районным точкам:
 * фото на проверке — сначала те, что ждут дольше всех; точки на доработке —
 * наверх по последнему отклонению; рядом счётчики точек по состояниям.
 */
export function districtQueueFromRows(rows) {
  const pending = [];
  const rework = [];
  const counts = { total: rows.length, empty: 0, pending: 0, accepted: 0, rework: 0 };
  for (const row of rows) {
    const point = { point_id: row.point_id, label: row.label, district: row.district, heading: row.heading, longitude: row.longitude, latitude: row.latitude };
    const state = pointState(row);
    counts[state.status] += 1;
    if (state.status === 'pending') {
      pending.push({ ...point, photo_id: state.photo.id, status: state.photo.status, uploaded_at: state.photo.uploaded_at, photo_filename: state.photo.photo_filename });
    }
    if (state.status === 'rework') {
      rework.push({ ...point, photo_id: state.rejected.id, uploaded_at: state.rejected.uploaded_at, photo_filename: state.rejected.photo_filename, rejected_comment: state.rejected.comment, rejected_at: state.rejected.reviewed_at });
    }
  }
  const stamp = (value) => new Date(value.rejected_at || value.uploaded_at || 0).getTime();
  pending.sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
  rework.sort((a, b) => stamp(b) - stamp(a));
  return { counts, pending, rework };
}

const REVIEW_COLUMNS = 'id, point_id, uploaded_by, uploaded_at, status, review_comment, reviewed_by, reviewed_at';

/** Маршруты кабинета и методы хранилища; write — общая транзакция аудита. */
export function mountDistrictPointPhotoRoutes(router, { repository }) {
  const prefecture = (req, res, next) => req.user.role === 'prefecture_admin' ? next() : res.status(403).json({ error: 'Фото точек съёмки проверяет только префектура.' });

  router.get('/district-photos/queue', prefecture, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(districtQueueFromRows(await repository.listDistrictPointPhotoQueue()));
    } catch (error) { next(error); }
  });

  router.post('/district-photos/photos/:photoId/review', prefecture, async (req, res, next) => {
    try {
      const validation = validateReview(req.body);
      if (!validation.valid) return res.status(422).json({ error: validation.error });
      const photo = await repository.reviewDistrictPointPhoto({ id: req.params.photoId, ...validation.value, actorId: req.user.sub });
      if (!photo) return res.status(409).json({ error: 'Фото уже отклонено. Дождитесь нового снимка от района.' });
      res.json({ photo });
    } catch (error) { next(error); }
  });
}

export function createDistrictPointPhotoRepository(pool, write) {
  return {
    async listDistrictPointPhotoQueue() {
      const { rows } = await pool.query(`
        SELECT p.id AS point_id, p.label, p.district, p.heading, p.longitude, p.latitude,
               f.id AS photo_id, f.status AS photo_status, f.uploaded_at, f.photo_filename,
               r.id AS rejected_photo_id, r.review_comment AS rejected_comment,
               r.reviewed_at AS rejected_at, r.uploaded_at AS rejected_uploaded_at,
               r.photo_filename AS rejected_photo_filename
        FROM object_photo_points p
        LEFT JOIN LATERAL (
          SELECT t.id, t.status, t.uploaded_at, t.photo_filename
          FROM object_photo_point_photos t
          WHERE t.point_id = p.id AND t.dataset_id = 'sao_district_photo_points'
            AND t.status IN ('pending', 'accepted')
          ORDER BY t.uploaded_at DESC, t.id DESC LIMIT 1
        ) f ON true
        LEFT JOIN LATERAL (
          SELECT t.id, t.review_comment, t.reviewed_at, t.uploaded_at, t.photo_filename
          FROM object_photo_point_photos t
          WHERE t.point_id = p.id AND t.dataset_id = 'sao_district_photo_points' AND t.status = 'rejected'
          ORDER BY t.reviewed_at DESC, t.id DESC LIMIT 1
        ) r ON true
        WHERE p.dataset_id = 'sao_district_photo_points' AND p.retired_at IS NULL`);
      return rows;
    },
    reviewDistrictPointPhoto({ id, decision, comment, actorId }) {
      return write(actorId, 'district_point_photo_reviewed', { photoId: id, decision }, async (client) => {
        // Отклонённое фото уже освободило слот — повторно его не проверяем.
        const { rows } = await client.query(`UPDATE object_photo_point_photos SET status = $2, review_comment = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 AND status <> 'rejected' RETURNING ${REVIEW_COLUMNS}`, [id, decision, comment, actorId]);
        return rows[0] || null;
      });
    },
  };
}
