import express from 'express';
import { signToken, verifyPassword, verifyToken } from './lib/auth.js';
import { safePhotoFilename, validatePhotoMarker, validatePhotoNote, validatePhotoUpload } from './lib/photo-markers.js';
import { streamReviewArchive } from './lib/review-archive.js';
import { routeReport, routeReportCsv, routeReportCsvName } from './lib/route-report.js';
import { DISTRICTS, payloadHash, validateChangeSet } from './lib/validation.js';

const PREFECTURE_ROLE = 'prefecture_admin';
const DISTRICT_ROLE = 'district_editor';
const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function createApp({ repository, boundary, jwtSecret, allowedOrigins = [], notifier = null }) {
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET должен содержать минимум 32 символа.');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '6mb', type: ['application/json', 'application/geo+json'] }));
  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (!origin || allowedOrigins.includes(origin)) {
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Photo-Filename');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      if (request.method === 'OPTIONS') return response.sendStatus(204);
      return next();
    }
    return response.status(403).json({ error: 'Источник запроса не разрешён.' });
  });

  const authenticate = (request, response, next) => {
    try {
      const token = request.get('authorization')?.replace(/^Bearer\s+/i, '');
      request.user = verifyToken(token, jwtSecret);
      next();
    } catch (error) { response.status(401).json({ error: error.message }); }
  };
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const requireUuid = (request, response, next) => UUID_PATTERN.test(request.params.id || '')
    ? next() : response.status(404).json({ error: 'Объект не найден.' });
  // Приёмка, выгрузки и фото-метки — только роль префектуры. Второй роли приёмки нет.
  const requirePrefecture = (request, response, next) => request.user.role === PREFECTURE_ROLE
    ? next() : response.status(403).json({ error: 'Требуется роль префектуры.' });
  const photoParser = express.raw({ type: PHOTO_MIME_TYPES, limit: '5mb' });

  app.get('/api/health', async (_request, response, next) => {
    try { response.json({ ok: true, service: 'odh-sao-exchange-api' }); } catch (error) { next(error); }
  });

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      const { email, password } = request.body || {};
      const user = await repository.findUserByEmail(String(email || '').trim());
      if (!user || !await verifyPassword(password, user.password_hash)) return response.status(401).json({ error: 'Неверный e-mail или пароль.' });
      const safeUser = { id: user.id, email: user.email, role: user.role, district: user.district };
      response.json({ token: signToken(safeUser, jwtSecret), user: safeUser });
    } catch (error) { next(error); }
  });

  app.get('/api/me', authenticate, (request, response) => response.json({ user: request.user }));

  app.get('/api/photo-markers', authenticate, requirePrefecture, async (_request, response, next) => {
    try { response.json({ photoMarkers: await repository.listPhotoMarkers() }); } catch (error) { next(error); }
  });

  app.post('/api/photo-markers', authenticate, requirePrefecture, async (request, response, next) => {
    try {
      const validation = validatePhotoMarker(request.body, boundary);
      if (!validation.valid) return response.status(422).json({ error: 'Фото-метка не прошла проверку.', details: validation.errors });
      const photoMarker = await repository.createPhotoMarker({ ...validation.value, createdBy: request.user.sub });
      response.status(201).json({ photoMarker });
    } catch (error) { next(error); }
  });

  app.patch('/api/photo-markers/:id', authenticate, requireUuid, requirePrefecture, async (request, response, next) => {
    try {
      const validation = validatePhotoNote(request.body?.note);
      if (!validation.valid) return response.status(400).json({ error: validation.error });
      const photoMarker = await repository.updatePhotoMarkerNote({ id: request.params.id, note: validation.value, actorId: request.user.sub });
      if (!photoMarker) return response.status(404).json({ error: 'Фото-метка не найдена.' });
      response.json({ photoMarker });
    } catch (error) { next(error); }
  });

  app.put('/api/photo-markers/:id/photo', authenticate, requireUuid, requirePrefecture, photoParser, async (request, response, next) => {
    try {
      const validation = validatePhotoUpload(request.body, request.get('content-type'));
      if (!validation.valid) return response.status(422).json({ error: validation.error });
      const photoMarker = await repository.setPhotoMarkerPhoto({ id: request.params.id, bytes: request.body, mimeType: validation.mimeType, filename: safePhotoFilename(request.get('x-photo-filename')), actorId: request.user.sub });
      if (!photoMarker) return response.status(404).json({ error: 'Фото-метка не найдена.' });
      response.json({ photoMarker });
    } catch (error) { next(error); }
  });

  app.get('/api/photo-markers/:id/photo', authenticate, requireUuid, requirePrefecture, async (request, response, next) => {
    try {
      const photo = await repository.getPhotoMarkerPhoto(request.params.id);
      if (!photo?.photo_bytes) return response.status(404).json({ error: 'У этой фото-метки нет прикреплённого фото.' });
      response.setHeader('Cache-Control', 'private, no-store');
      response.type(photo.photo_mime_type).send(photo.photo_bytes);
    } catch (error) { next(error); }
  });

  app.delete('/api/photo-markers/:id/photo', authenticate, requireUuid, requirePrefecture, async (request, response, next) => {
    try {
      const photoMarker = await repository.deletePhotoMarkerPhoto({ id: request.params.id, actorId: request.user.sub });
      if (!photoMarker) return response.status(404).json({ error: 'Фото или фото-метка не найдены.' });
      response.json({ photoMarker });
    } catch (error) { next(error); }
  });

  app.delete('/api/photo-markers/:id', authenticate, requireUuid, requirePrefecture, async (request, response, next) => {
    try {
      const photoMarker = await repository.deletePhotoMarker({ id: request.params.id, actorId: request.user.sub });
      if (!photoMarker) return response.status(404).json({ error: 'Фото-метка не найдена.' });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.post('/api/submissions', authenticate, async (request, response, next) => {
    try {
      if (![DISTRICT_ROLE, PREFECTURE_ROLE].includes(request.user.role)) return response.status(403).json({ error: 'Нет права отправлять наборы.' });
      const { changeSet, originalFilename = 'pravki.geojson' } = request.body || {};
      const validation = validateChangeSet(changeSet, boundary);
      if (!validation.valid) return response.status(422).json({ error: 'Набор не прошёл проверку.', details: validation.errors });
      if (request.user.role === DISTRICT_ROLE && !request.user.district) return response.status(403).json({ error: 'Учётной записи редактора не назначен район.' });
      if (request.user.role === DISTRICT_ROLE && request.user.district !== changeSet.district) return response.status(403).json({ error: 'Редактор может отправлять только свой район.' });
      const submission = await repository.createSubmission({ changeSet, createdBy: request.user.sub, originalFilename: String(originalFilename).slice(0, 180), payloadSha256: payloadHash(changeSet) });
      // Префектуре уходит одно сообщение с кнопками: решать по набору можно прямо из Telegram.
      notifier?.action({
        name: 'submission.approve',
        title: `Набор правок на приёмку: ${submission.district}`,
        details: `Объектов: ${changeSet.features?.length || 0}. Исполнитель: ${changeSet.author || 'не указан'}.`,
        confirmText: 'Утвердить',
        payload: { service: 'odh', submissionId: submission.id, district: submission.district }
      });
      response.status(201).json({ submission: { id: submission.id, district: submission.district, status: submission.status, submitted_at: submission.submitted_at } });
    } catch (error) { next(error); }
  });

  // Счётчик приёмки в прямом эфире: одни числа, без наборов. Полная выдача тянет
  // change_set каждого набора, а счётчик опрашивается каждые полминуты.
  app.get('/api/submissions/stats', authenticate, requirePrefecture, async (_request, response, next) => {
    try {
      const stats = await repository.submissionStats();
      response.json({ ...stats, checkedAt: new Date().toISOString() });
    } catch (error) { next(error); }
  });

  app.get('/api/submissions', authenticate, requirePrefecture, async (request, response, next) => {
    try {
      const status = request.query.status;
      if (status && !['submitted', 'approved', 'rejected'].includes(status)) return response.status(400).json({ error: 'Неизвестный статус.' });
      const submissions = await repository.listSubmissions({ status, district: request.query.district });
      response.json({ submissions });
    } catch (error) { next(error); }
  });

  // Район видит только статус своих наборов: чужой район недоступен, выгрузок нет.
  app.get('/api/my-submissions', authenticate, async (request, response, next) => {
    try {
      if (request.user.role !== DISTRICT_ROLE) return response.status(403).json({ error: 'Ручка доступна только учётной записи района.' });
      if (!request.user.district) return response.status(403).json({ error: 'Учётной записи редактора не назначен район.' });
      const submissions = await repository.listSubmissions({ district: request.user.district });
      response.json({
        district: request.user.district,
        submissions: submissions.map((item) => ({
          id: item.id,
          district: item.district,
          status: item.status,
          submitted_at: item.submitted_at,
          reviewed_at: item.reviewed_at ?? null,
          review_comment: item.review_comment ?? null,
          features: Array.isArray(item.change_set?.features) ? item.change_set.features.length : 0
        }))
      });
    } catch (error) { next(error); }
  });

  app.patch('/api/submissions/:id', authenticate, requireUuid, requirePrefecture, async (request, response, next) => {
    try {
      const { status, comment } = request.body || {};
      if (!['approved', 'rejected'].includes(status)) return response.status(400).json({ error: 'Допустимы только approved или rejected.' });
      // Пустой комментарий приходит как null или отсутствует — это не ошибка.
      // Тип и длину проверяем порознь, иначе число в комментарии получало бы
      // неверное объяснение «слишком длинный».
      const reviewComment = comment == null ? '' : comment;
      if (typeof reviewComment !== 'string') return response.status(400).json({ error: 'Комментарий должен быть строкой.' });
      if (reviewComment.length > 2000) return response.status(400).json({ error: 'Комментарий слишком длинный.' });
      const submission = await repository.reviewSubmission({ id: request.params.id, status, reviewerId: request.user.sub, comment: reviewComment.trim() });
      if (!submission) return response.status(404).json({ error: 'Набор не найден.' });
      response.json({ submission: { id: submission.id, status: submission.status, reviewed_at: submission.reviewed_at } });
    } catch (error) { next(error); }
  });

  app.get('/api/exports/approved.geojson', authenticate, requirePrefecture, async (_request, response, next) => {
    try {
      const approved = await repository.listSubmissions({ status: 'approved' });
      response.type('application/geo+json').attachment(`svod-pravok-sao-${new Date().toISOString().slice(0, 10)}.geojson`).json({
        type: 'FeatureCollection',
        review_bundle_version: 'district_review_bundle_v2',
        review_status: 'approved',
        exported_at: new Date().toISOString(),
        sources: approved.map((item) => ({ id: item.id, district: item.district, author: item.author, original_filename: item.original_filename, submitted_at: item.submitted_at, reviewed_at: item.reviewed_at })),
        features: approved.flatMap((item) => item.change_set.features.map((feature) => ({ ...feature, properties: { ...feature.properties, submission_id: item.id, review_status: 'approved' } })))
      });
    } catch (error) { next(error); }
  });

  app.get('/api/exports/review-archive.zip', authenticate, requirePrefecture, async (_request, response, next) => {
    try {
      const submitted = await repository.listSubmissions({ status: 'submitted' });
      const date = new Date().toISOString().slice(0, 10);
      response.status(200).type('application/zip').attachment(`pravki-sao-k-priemke-${date}.zip`);
      await streamReviewArchive(response, submitted);
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else next(error);
    }
  });

  // Отчёт о состоянии отрисовки маршрутов ОДХ — та же выборка, что уходит
  // выгрузкой: сначала JSON для кабинета, затем CSV-файл. Доступ только у
  // префектуры, как и у остальных выгрузок.
  app.get('/api/reports/routes', authenticate, requirePrefecture, async (_request, response, next) => {
    try {
      const report = routeReport(await repository.routeReportRows(), { districtNames: [...DISTRICTS] });
      response.json({ ...report, csvName: routeReportCsvName(report) });
    } catch (error) { next(error); }
  });

  app.get('/api/reports/routes.csv', authenticate, requirePrefecture, async (_request, response, next) => {
    try {
      const report = routeReport(await repository.routeReportRows(), { districtNames: [...DISTRICTS] });
      response.type('text/csv; charset=utf-8').attachment(routeReportCsvName(report)).send(routeReportCsv(report));
    } catch (error) { next(error); }
  });

  app.use((error, _request, response, _next) => {
    // Сбой разбора тела — ошибка клиента, а не сервера: body-parser помечает её
    // статусом 400 (повреждённый JSON) или 413 (тело больше 6 МБ). Раньше любой
    // такой отказ превращался в 500 и клиент не понимал, что чинить.
    const status = Number(error?.status || error?.statusCode || 0);
    if (status >= 400 && status < 500) {
      const message = status === 413
        ? 'Тело запроса слишком большое.'
        : error?.type === 'entity.parse.failed'
          ? 'Тело запроса не является корректным JSON.'
          : 'Некорректный запрос.';
      return response.status(status).json({ error: message });
    }
    console.error(error);
    response.status(500).json({ error: 'Внутренняя ошибка API.' });
  });
  return app;
}
