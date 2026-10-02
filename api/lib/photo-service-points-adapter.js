import express from 'express';
import { createObjectPhotoPointRepository, createObjectPhotoPointsRouter } from './object-photo-points.js';

// Mount into the existing photo service using its pool, sessions and audit log.
export function createPhotoServicePointsAdapter({ pool, currentUser, boundary }) {
  const repository = createObjectPhotoPointRepository(pool, {
    writeAudit(client, { actorId, eventType, metadata }) {
      return client.query('INSERT INTO audit_log (actor_user_id, action, object_key, metadata) VALUES ($1,$2,$3,$4::jsonb)', [actorId, eventType, metadata.objectKey || null, JSON.stringify(metadata)]);
    },
  });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  const authenticate = async (req, res, next) => {
    try {
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: 'Войдите в учётную запись фотослужбы.' });
      req.user = { ...user, sub: user.id };
      next();
    } catch (error) { next(error); }
  };
  app.use('/object-photo-points', createObjectPhotoPointsRouter({ repository, authenticate, boundary }));
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Не удалось обработать запрос.' });
  });
  return app;
}
