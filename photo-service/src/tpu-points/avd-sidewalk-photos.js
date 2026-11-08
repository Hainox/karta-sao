import { acceptedPhotoBytes, mountAcceptedPhotoExport } from './accepted-photo-export.js';
import express from 'express';
import { resizeJpeg } from '../image-resize.js';
import { randomUUID } from 'node:crypto';
import { DISTRICTS } from './validation.js';
import { isAutodorAccount } from '../scope.js';
import { safePhotoFilename, validatePhotoUpload } from './photo-markers.js';
import { validateReview } from './object-slots.js';
import { districtQueueFromRows, slotPointsForReport } from './district-point-photos.js';
import { buildDigitizationReport, summarizeDigitization } from '../digitization-report.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const noFrame = (res) => res.status(404).json({ error: 'Фотослот не найден.' });
export const isAvdSidewalkEditor = (user) => user.role === 'district_editor' && isAutodorAccount(user.district);
// «Баланс» из последнего Excel. Правило для остановок и ДЭУ здесь не применяется.
export const isAvdSidewalkPoint = (point) => isAutodorAccount(point.balance);
const districtOwner = balance => balance === 'ГБУ «Жилищник района Ховрино»' ? 'Ховрино' : balance;
export const isDistrictSidewalkEditor = user => user.role === 'district_editor' && DISTRICTS.has(user.district);
export const districtOwnsSidewalk = (user, point) => isDistrictSidewalkEditor(user) && districtOwner(point.balance) === user.district;
const isPrefecture = (req) => req.user.role === 'prefecture_admin';

// Кабинет приёмки листает кадры подряд: полный снимок (в среднем 2,7 МБ) на
// каждый переход — это секунды ожидания. Для решения «принять / вернуть»
// достаточно 1600 px по длинной стороне; оригинал открывается отдельной кнопкой.
export const PREVIEW_MAX = 1600;
const PREVIEW_QUALITY = 78;

/** Уменьшает кадр до PREVIEW_MAX по длинной стороне и пережимает в JPEG. */
export async function renderPreview(bytes, options = {}) {
  return resizeJpeg(bytes, { max: PREVIEW_MAX, quality: PREVIEW_QUALITY, ...options });
}

/** Последнее действующее фото каждого слота: отклонённая пересдача сбрасывает «пусто». */
export const loadSidewalkPhotos = async pool => {
  const { rows } = await pool.query(`SELECT DISTINCT ON (frame_id)
    frame_id, id, status, photo_filename, uploaded_at, review_comment, reviewed_at
    FROM avd_sidewalk_test_photos ORDER BY frame_id, (status <> 'rejected') DESC, uploaded_at DESC, id DESC`);
  return new Map(rows.map(row => [row.frame_id, row]));
};
/** Статус слота для слоя и карты: отклонённое фото показывает «на доработке». */
export const sidewalkSlotStatus = (slot, photo) => ({ ...slot,
  status: photo?.status === 'rejected' ? 'rework' : photo?.status || 'empty',
  photoId: photo?.id || null,
  comment: photo?.status === 'rejected' ? photo.review_comment || '' : '' });

export function createAvdSidewalkPhotosRouter({ authenticate, pool, loadCatalog, loadEdits, mergePoint, scope = 'avd' }) {
  const router = express.Router();
  const isDistrict = scope === 'district';
  const isEditor = isDistrict ? isDistrictSidewalkEditor : isAvdSidewalkEditor;
  const pointsFor = (catalog, req) => isDistrict
    ? catalog.districtPoints.filter(point => isPrefecture(req) || districtOwnsSidewalk(req.user, point))
    : catalog.avdPoints;
  // Приёмка работает с единым набором: у префектуры согласован поиск по кадрам
  // обоих скоупов (обзор, проверка снимков среди районных и АвД-точек).
  const framesFor = catalog => isDistrict
    ? new Map([...catalog.districtFrames, ...catalog.avdFrames])
    : catalog.avdFrames;
  router.use(authenticate, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (isPrefecture(req) || isEditor(req.user)) return next();
    res.status(403).json({ error: 'Нет доступа к этому набору точек.' });
  });
  const prefectureOnly = (req, res, next) => isPrefecture(req)
    ? next() : res.status(403).json({ error: 'Снимки проверяет префектура.' });
  const editorOnly = (req, res, next) => isEditor(req.user)
    ? next() : res.status(403).json({ error: 'Фотослот заполняет ответственный за точку.' });

  const findFrame = async (id, req) => {
    const point = framesFor(await loadCatalog()).get(id);
    return point && (!isDistrict || isPrefecture(req) || districtOwnsSidewalk(req.user, point)) ? point : null;
  };
  const currentPhotos = async () => loadSidewalkPhotos(pool);
  const audit = (client, req, action, pointId, metadata) => client.query(
    'INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)',
    [req.user.id, action, 'sidewalk-test:' + pointId, JSON.stringify(metadata)]);
  async function transaction(operation) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  router.get('/', async (req, res, next) => {
    try {
      const [catalog, edits, photos] = await Promise.all([loadCatalog(), loadEdits(), currentPhotos()]);
      const points = pointsFor(catalog, req).map(source => {
        const point = mergePoint(source, edits.get(source.id));
        return { ...point, slots: point.slots.map(slot => sidewalkSlotStatus(slot, photos.get(slot.id))) };
      });
      res.json({ points });
    } catch (error) { next(error); }
  });

  async function loadQueueRows(req) {
    const [catalog, edits, photos] = await Promise.all([loadCatalog(), loadEdits(), currentPhotos()]);
    // Приёмка — один набор: у префектуры кадры АвД (они работают по всему округу)
    // идут той же очередью и в своде выглядят отдельной строкой «АВД САО» — 17-й район.
    const sources = isDistrict && isPrefecture(req) ? [...catalog.districtPoints, ...catalog.avdPoints] : pointsFor(catalog, req);
    const rows = sources.flatMap(source => {
      const point = mergePoint(source, edits.get(source.id));
      const district = isDistrict && isAvdSidewalkPoint(point) ? 'АВД САО' : point.district;
      return point.slots.flatMap((slot, index) => {
        const photo = photos.get(slot.id);
        if (point.noSidewalk && !photo) return [];
        const active = photo && photo.status !== 'rejected' ? photo : null;
        const rejected = photo?.status === 'rejected' ? photo : null;
        return [{ point_id: slot.id, label: point.street + ' · ' + point.id + ' · кадр ' + (index + 1),
          district, object_id: point.id, heading: slot.azimuth, longitude: point.coordinates[0], latitude: point.coordinates[1],
          no_sidewalk: point.noSidewalk === true,
          photo_id: active?.id, photo_status: active?.status, uploaded_at: active?.uploaded_at, photo_filename: active?.photo_filename, reviewed_at: active?.reviewed_at,
          rejected_photo_id: rejected?.id, rejected_comment: rejected?.review_comment, rejected_at: rejected?.reviewed_at,
          rejected_uploaded_at: rejected?.uploaded_at, rejected_photo_filename: rejected?.photo_filename }];
      });
    });
    return { catalog, rows };
  }
  mountAcceptedPhotoExport(router, {
    prefecture: prefectureOnly, category: isDistrict ? 'Тротуары ОДХ' : 'Тротуары ОДХ · АвД САО',
    loadRows: async req => (await loadQueueRows(req)).rows,
    loadPhoto: row => acceptedPhotoBytes(pool, row, 'avd_sidewalk_test_photos', 'frame_id'),
  });
  router.get('/queue', prefectureOnly, async (req, res, next) => {
    try {
      const { catalog, rows } = await loadQueueRows(req);
      const queue = districtQueueFromRows(rows);
      const noSidewalk = new Map(rows.map(row => [row.point_id, row.no_sidewalk]));
      const withPoint = row => ({ ...row, source_point_id: framesFor(catalog).get(row.point_id).id, no_sidewalk: noSidewalk.get(row.point_id) === true });
      res.json({ ...queue, pending: queue.pending.map(withPoint), rework: queue.rework.map(withPoint) });
    } catch (error) { next(error); }
  });

  // Свод по районам — та же книга Excel, что у въездных групп, ДП/СП и тротуаров
  // дворов: лист «Свод по районам», «Точки» и «На доработке» с причиной возврата.
  // Книга одна на весь набор тротуаров ОДХ: кадры АвД входят строкой «АВД САО»,
  // поэтому отдельный скоуп-свод не строится.
  if (isDistrict) router.get('/report.xlsx', prefectureOnly, async (req, res, next) => {
    try {
      const generatedAt = new Date();
      const summary = summarizeDigitization({ points: slotPointsForReport((await loadQueueRows(req)).rows), generatedAt });
      const buffer = await buildDigitizationReport(summary, {
        title: 'Оцифровка тротуаров ОДХ',
        pointTitle: 'Кадр',
      });
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(generatedAt);
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Svod_foto_trotuary_odh_SAO_${day}.xlsx"`,
        'Cache-Control': 'private, no-store' }).send(buffer);
    } catch (error) { next(error); }
  });

  router.get('/frames/:frameId/photos/:photoId', async (req, res, next) => {
    try {
      const { frameId, photoId } = req.params;
      if (!UUID.test(photoId) || !await findFrame(frameId, req)) return noFrame(res);
      const { rows } = await pool.query('SELECT photo_bytes, photo_mime_type FROM avd_sidewalk_test_photos WHERE frame_id = $1 AND id = $2', [frameId, photoId]);
      if (!rows[0]) return res.status(404).json({ error: 'Фото не найдено.' });
      // photo_id неизменяем: один и тот же URL всегда отдаёт один и тот же файл,
      // поэтому браузер может держать его сутки и не качать при возврате назад.
      res.set('Cache-Control', 'private, max-age=86400, immutable')
        .set('X-Content-Type-Options', 'nosniff').type(rows[0].photo_mime_type).send(rows[0].photo_bytes);
    } catch (error) { next(error); }
  });

  // Превью для листания кадров: 1600 px вместо полного снимка. Первый запрос
  // сжимает и кладёт в таблицу, дальше отдаётся из неё.
  router.get('/frames/:frameId/photos/:photoId/preview', async (req, res, next) => {
    try {
      const { frameId, photoId } = req.params;
      if (!UUID.test(photoId) || !await findFrame(frameId, req)) return noFrame(res);
      const cached = await pool.query(
        'SELECT photo_bytes, photo_mime_type FROM avd_sidewalk_test_photo_previews WHERE photo_id = $1', [photoId]);
      if (cached.rows[0]) {
        return res.set('Cache-Control', 'private, max-age=86400, immutable')
          .set('X-Content-Type-Options', 'nosniff')
          .type(cached.rows[0].photo_mime_type).send(cached.rows[0].photo_bytes);
      }
      const { rows } = await pool.query(
        'SELECT photo_bytes FROM avd_sidewalk_test_photos WHERE frame_id = $1 AND id = $2', [frameId, photoId]);
      if (!rows[0]) return res.status(404).json({ error: 'Фото не найдено.' });
      let preview;
      try {
        preview = await renderPreview(rows[0].photo_bytes);
      } catch {
        // Битый файл не должен ломать приёмку: отдаём оригинал как есть.
        return res.set('Cache-Control', 'private, max-age=3600')
          .set('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(rows[0].photo_bytes);
      }
      await pool.query(
        `INSERT INTO avd_sidewalk_test_photo_previews (photo_id, photo_bytes, photo_mime_type, photo_size, width, height)
         VALUES ($1,$2,'image/jpeg',$3,$4,$5) ON CONFLICT (photo_id) DO NOTHING`,
        [photoId, preview.bytes, preview.bytes.length, preview.width, preview.height]);
      res.set('Cache-Control', 'private, max-age=86400, immutable')
        .set('X-Content-Type-Options', 'nosniff')
        .type('image/jpeg').send(preview.bytes);
    } catch (error) { next(error); }
  });

  router.put('/frames/:frameId/photo', editorOnly, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), async (req, res, next) => {
    try {
      const { frameId } = req.params;
      const point = await findFrame(frameId, req);
      if (!point) return noFrame(res);
      // Пометка «Нет тротуара» загрузке кадра не мешает — приёмка видит её отдельной меткой.
      const valid = validatePhotoUpload(req.body, req.get('content-type'));
      if (!valid.valid) return res.status(422).json({ error: valid.error });
      const photo = await transaction(async client => {
        const { rows } = await client.query(`INSERT INTO avd_sidewalk_test_photos
          (id, frame_id, status, photo_bytes, photo_mime_type, photo_filename, photo_size, uploaded_by)
          VALUES ($1,$2,'pending',$3,$4,$5,$6,$7) RETURNING id, status`,
        [randomUUID(), frameId, req.body, valid.mimeType, safePhotoFilename(req.get('x-photo-filename')), req.body.length, req.user.id]);
        await audit(client, req, 'avd_sidewalk_photo_uploaded', point.id, { frameId, photoId: rows[0].id });
        return rows[0];
      });
      res.status(201).json({ photo });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'В этом фотослоте уже есть снимок.' });
      next(error);
    }
  });

  router.post('/frames/:frameId/photos/:photoId/review', prefectureOnly, async (req, res, next) => {
    try {
      const { frameId, photoId } = req.params;
      const point = await findFrame(frameId, req);
      if (!point || !UUID.test(photoId)) return noFrame(res);
      const validation = validateReview(req.body);
      if (!validation.valid) return res.status(422).json({ error: validation.error });
      const { decision, comment } = validation.value;
      const photo = await transaction(async client => {
        const { rows } = await client.query(`UPDATE avd_sidewalk_test_photos
          SET status = $3, review_comment = $4, reviewed_by = $5, reviewed_at = now()
          WHERE frame_id = $1 AND id = $2 AND status = 'pending' RETURNING id, status`,
        [frameId, photoId, decision, comment, req.user.id]);
        if (rows[0]) await audit(client, req, 'avd_sidewalk_photo_reviewed', point.id, { frameId, photoId, decision });
        return rows[0];
      });
      if (!photo) return res.status(409).json({ error: 'Снимок уже проверен или не относится к этому фотослоту.' });
      res.json({ photo });
    } catch (error) { next(error); }
  });
  return router;
}
