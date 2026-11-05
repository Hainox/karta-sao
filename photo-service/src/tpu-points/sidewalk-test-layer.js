import express from 'express';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DISTRICTS, isPointWithinBoundary } from './validation.js';
import { mediaRoot } from '../storage.js';
import { createAvdSidewalkPhotosRouter, isAvdSidewalkEditor, isAvdSidewalkPoint } from './avd-sidewalk-photos.js';

const DEFAULT_CATALOG = new URL('../../assets/sidewalk-test-points.json', import.meta.url);

function indexCatalog({ version, points }) {
  if (version !== 1 || !Array.isArray(points) || !points.length) throw new Error('Некорректный каталог тестового слоя.');
  const districts = new Map();
  const byId = new Map();
  const slotIds = new Set();
  const avdPoints = [];
  const avdFrames = new Map();
  for (const point of points) {
    const { id, district, coordinates, slots } = point;
    if (typeof id !== 'string' || !id || byId.has(id) || !DISTRICTS.has(district)
        || !Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
        || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90
        || !Array.isArray(slots) || ![1, 2].includes(slots.length)) throw new Error('Некорректная тестовая точка.');
    byId.set(id, point);
    const avd = isAvdSidewalkPoint(point);
    if (avd) avdPoints.push(point);
    for (const { id: slotId, azimuth } of slots) {
      if (typeof slotId !== 'string' || !slotId || slotIds.has(slotId)
          || !Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360) throw new Error('Некорректный фотослот.');
      slotIds.add(slotId);
      if (avd) avdFrames.set(slotId, point);
    }
    if (!districts.has(district)) districts.set(district, []);
    districts.get(district).push(point);
  }
  return { districts, byId, avdPoints, avdFrames };
}

const mergePoint = (point, edit) => ({
  ...point,
  coordinates: edit?.coordinates || point.coordinates,
  ...(edit?.noSidewalk ? { noSidewalk: true } : {}),
  slots: point.slots.map(slot => ({ ...slot, azimuth: edit?.angles?.[slot.id] ?? slot.azimuth })),
});

// Исходный каталог неизменяем. Правки живут в постоянном томе фотослужбы.
export function createSidewalkTestLayerRouter({ authenticate, boundary, pool, catalogPath = DEFAULT_CATALOG,
  editsPath = join(mediaRoot(), 'sidewalk-test', 'edits.json') }) {
  const router = express.Router();
  let catalog;
  let stored;
  let writes = Promise.resolve();
  const loadCatalog = () => catalog ??= readFile(catalogPath, 'utf8').then(JSON.parse).then(indexCatalog).catch(error => {
    catalog = undefined;
    if (error.code === 'ENOENT') throw Object.assign(new Error('Тестовый слой ещё не загружен.'), { status: 503 });
    throw error;
  });
  const loadEdits = () => stored ??= readFile(editsPath, 'utf8').then(JSON.parse).then(entries => new Map(entries)).catch(error => {
    if (error.code === 'ENOENT') return new Map();
    stored = undefined;
    throw error;
  });
  const prefecture = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.user.role !== 'prefecture_admin') return res.status(403).json({ error: 'Тестовый слой доступен только префектуре.' });
    next();
  };
  router.get('/', authenticate, prefecture, async (req, res, next) => {
    const { district } = req.query;
    if (!DISTRICTS.has(district)) return res.status(400).json({ error: 'Укажите район САО.' });
    try {
      const [{ districts }, edits] = await Promise.all([loadCatalog(), loadEdits()]);
      res.json({ points: (districts.get(district) || []).map(point => mergePoint(point, edits.get(point.id))) });
    } catch (error) { next(error); }
  });

  router.get('/no-sidewalk', authenticate, prefecture, async (_req, res, next) => {
    try {
      const [{ byId }, edits] = await Promise.all([loadCatalog(), loadEdits()]);
      const points = [];
      for (const [id, edit] of edits) {
        const point = byId.get(id);
        if (point && edit.noSidewalk) points.push({ id, district: point.district, street: point.street });
      }
      points.sort((a, b) => a.district.localeCompare(b.district, 'ru') || a.street.localeCompare(b.street, 'ru') || a.id.localeCompare(b.id));
      res.json({ points });
    } catch (error) { next(error); }
  });

  router.use('/avd', createAvdSidewalkPhotosRouter({ authenticate, pool, loadCatalog, loadEdits, mergePoint }));

  router.patch('/:pointId', authenticate, async (req, res, next) => {
    const { coordinates, slotId, azimuth, noSidewalk } = req.body || {};
    const keys = Object.keys(req.body || {});
    const move = keys.length === 1 && keys[0] === 'coordinates';
    const rotate = keys.length === 2 && keys.includes('slotId') && keys.includes('azimuth');
    const mark = keys.length === 1 && keys[0] === 'noSidewalk' && typeof noSidewalk === 'boolean';
    const avd = isAvdSidewalkEditor(req.user);
    res.set('Cache-Control', 'private, no-store');
    if (req.user.role !== 'prefecture_admin' && !(avd && mark)) {
      return res.status(403).json({ error: 'Геометрию и направления меняет только префектура.' });
    }
    if (move) {
      if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
          || coordinates[0] < 37.2 || coordinates[0] >= 37.8 || coordinates[1] < 55.7 || coordinates[1] >= 56.05
          || (boundary && !isPointWithinBoundary(coordinates, boundary))) {
        return res.status(400).json({ error: 'Точку можно передвинуть только в пределах САО.' });
      }
    } else if (!mark && (!rotate || typeof slotId !== 'string' || !Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360)) {
      return res.status(400).json({ error: 'Передайте координаты, ID слота с азимутом от 0 до 360° (не включая 360°) или пометку «Нет тротуара».' });
    }
    try {
      const { byId } = await loadCatalog();
      const point = byId.get(req.params.pointId);
      if (!point || (avd && !isAvdSidewalkPoint(point)) || (rotate && !point.slots.some(slot => slot.id === slotId))) {
        return res.status(404).json({ error: 'Точка или её фотослот не найдены.' });
      }
      // Один процесс фотослужбы: очередь не даёт параллельным правкам перетереть друг друга.
      const job = writes.then(async () => {
        const edits = new Map(await loadEdits());
        const current = edits.get(point.id) || {};
        const updated = move ? { ...current, coordinates } : mark ? { ...current, noSidewalk } : { ...current, angles: { ...current.angles, [slotId]: azimuth } };
        edits.set(point.id, updated);
        await mkdir(dirname(editsPath), { recursive: true });
        const temp = editsPath + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temp, JSON.stringify([...edits]), { flag: 'wx', mode: 0o600 });
          await rename(temp, editsPath);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        stored = Promise.resolve(edits);
        return mergePoint(point, updated);
      });
      writes = job.catch(() => {});
      res.json({ point: await job });
    } catch (error) { next(error); }
  });
  return router;
}
