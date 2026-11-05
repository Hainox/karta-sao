import express from 'express';
import { readFile } from 'node:fs/promises';
import { DISTRICTS } from './validation.js';

const DEFAULT_CATALOG = new URL('../../assets/sidewalk-test-points.json', import.meta.url);

function indexCatalog({ version, points }) {
  if (version !== 1 || !Array.isArray(points) || !points.length) throw new Error('Некорректный каталог тестового слоя.');
  const districts = new Map();
  const ids = new Set();
  const slotIds = new Set();
  for (const point of points) {
    const { id, district, coordinates, slots } = point;
    if (typeof id !== 'string' || !id || ids.has(id) || !DISTRICTS.has(district)
        || !Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
        || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90
        || !Array.isArray(slots) || ![1, 2].includes(slots.length)) throw new Error('Некорректная тестовая точка.');
    ids.add(id);
    for (const { id: slotId, azimuth } of slots) {
      if (typeof slotId !== 'string' || !slotId || slotIds.has(slotId)
          || !Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360) throw new Error('Некорректный фотослот.');
      slotIds.add(slotId);
    }
    if (!districts.has(district)) districts.set(district, []);
    districts.get(district).push(point);
  }
  return districts;
}

// Каталог ставится только на сервере. Его нельзя публиковать вместе с GitHub Pages.
export function createSidewalkTestLayerRouter({ authenticate, catalogPath = DEFAULT_CATALOG }) {
  const router = express.Router();
  let catalog;
  router.get('/', authenticate, async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.user.role !== 'prefecture_admin') return res.status(403).json({ error: 'Тестовый слой доступен только префектуре.' });
    const { district } = req.query;
    if (!DISTRICTS.has(district)) return res.status(400).json({ error: 'Укажите район САО.' });
    try {
      catalog ??= readFile(catalogPath, 'utf8').then(JSON.parse).then(indexCatalog).catch((error) => {
        catalog = undefined;
        throw error;
      });
      res.json({ points: (await catalog).get(district) || [] });
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(503).json({ error: 'Тестовый слой ещё не загружен.' });
      next(error);
    }
  });
  return router;
}
