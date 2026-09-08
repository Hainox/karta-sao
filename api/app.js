import express from 'express';
import { signToken, verifyPassword, verifyToken } from './lib/auth.js';
import { payloadHash, validateChangeSet } from './lib/validation.js';

const REVIEW_ROLES = new Set(['reviewer', 'prefecture_admin']);

export function createApp({ repository, boundary, jwtSecret, allowedOrigins = [] }) {
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET должен содержать минимум 32 символа.');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '6mb', type: ['application/json', 'application/geo+json'] }));
  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (!origin || allowedOrigins.includes(origin)) {
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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
  const requireReview = (request, response, next) => REVIEW_ROLES.has(request.user.role)
    ? next() : response.status(403).json({ error: 'Требуется роль приёмки или префектуры.' });

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

  app.post('/api/submissions', authenticate, async (request, response, next) => {
    try {
      if (!['district_editor', 'reviewer', 'prefecture_admin'].includes(request.user.role)) return response.status(403).json({ error: 'Нет права отправлять наборы.' });
      const { changeSet, originalFilename = 'pravki.geojson' } = request.body || {};
      const validation = validateChangeSet(changeSet, boundary);
      if (!validation.valid) return response.status(422).json({ error: 'Набор не прошёл проверку.', details: validation.errors });
      if (request.user.role === 'district_editor' && request.user.district && request.user.district !== changeSet.district) return response.status(403).json({ error: 'Редактор может отправлять только свой район.' });
      const submission = await repository.createSubmission({ changeSet, createdBy: request.user.sub, originalFilename: String(originalFilename).slice(0, 180), payloadSha256: payloadHash(changeSet) });
      response.status(201).json({ submission: { id: submission.id, district: submission.district, status: submission.status, submitted_at: submission.submitted_at } });
    } catch (error) { next(error); }
  });

  app.get('/api/submissions', authenticate, async (request, response, next) => {
    try {
      const status = request.query.status;
      if (status && !['submitted', 'approved', 'rejected'].includes(status)) return response.status(400).json({ error: 'Неизвестный статус.' });
      const district = REVIEW_ROLES.has(request.user.role) ? request.query.district : request.user.district;
      const submissions = await repository.listSubmissions({ status, district });
      response.json({ submissions });
    } catch (error) { next(error); }
  });

  app.patch('/api/submissions/:id', authenticate, requireReview, async (request, response, next) => {
    try {
      const { status, comment = '' } = request.body || {};
      if (!['approved', 'rejected'].includes(status)) return response.status(400).json({ error: 'Допустимы только approved или rejected.' });
      if (typeof comment !== 'string' || comment.length > 2000) return response.status(400).json({ error: 'Комментарий слишком длинный.' });
      const submission = await repository.reviewSubmission({ id: request.params.id, status, reviewerId: request.user.sub, comment: comment.trim() });
      if (!submission) return response.status(404).json({ error: 'Набор не найден.' });
      response.json({ submission: { id: submission.id, status: submission.status, reviewed_at: submission.reviewed_at } });
    } catch (error) { next(error); }
  });

  app.get('/api/exports/approved.geojson', authenticate, requireReview, async (_request, response, next) => {
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

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: 'Внутренняя ошибка API.' });
  });
  return app;
}
