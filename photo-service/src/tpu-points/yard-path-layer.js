import express from 'express';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DISTRICTS, isPointWithinBoundary } from './validation.js';
import { mediaRoot } from '../storage.js';
import { createAvdSidewalkPhotosRouter, districtOwnsSidewalk, loadSidewalkPhotos, sidewalkSlotStatus, isAvdSidewalkPoint, isDistrictSidewalkEditor } from './yard-path-photos.js';

const DEFAULT_CATALOG = new URL('../../assets/yard-path-points.json', import.meta.url);

function indexCatalog({ version, points, singleFrame = false }) {
  if (version !== 1 || !Array.isArray(points) || !points.length) throw new Error('Некорректный каталог тестового слоя.');
  const districts = new Map();
  const byId = new Map();
  const slotIds = new Set();
  const avdPoints = [];
  const avdFrames = new Map();
  const districtPoints = [];
  const districtFrames = new Map();
  for (const point of points) {
    const { id, district, coordinates, slots } = point;
    if (typeof id !== 'string' || !id || byId.has(id) || !DISTRICTS.has(district)
        || !Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
        || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90
        || !Array.isArray(slots) || slots.length < 1 || slots.length > (singleFrame ? 1 : 6)) throw new Error('Некорректная тестовая точка.');
    byId.set(id, point);
    const avd = isAvdSidewalkPoint(point);
    (avd ? avdPoints : districtPoints).push(point);
    for (const { id: slotId, azimuth } of slots) {
      if (typeof slotId !== 'string' || !slotId || slotIds.has(slotId)
          || !Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360) throw new Error('Некорректный фотослот.');
      slotIds.add(slotId);
      (avd ? avdFrames : districtFrames).set(slotId, point);
    }
    if (!districts.has(district)) districts.set(district, []);
    districts.get(district).push(point);
  }
  return { districts, byId, points, avdPoints, avdFrames, districtPoints, districtFrames, singleFrame };
}

export const mergePoint = (point, edit) => {
  const removed = new Set(edit?.removedSlots || []);
  const slots = [
    ...(point.slots || []).filter(slot => !removed.has(slot.id))
      .map(slot => ({ ...slot, azimuth: edit?.angles?.[slot.id] ?? slot.azimuth })),
    ...(edit?.addedSlots || []).filter(slot => !removed.has(slot.id)).map(slot => ({ ...slot })),
  ];
  return {
    ...point,
    coordinates: edit?.coordinates || point.coordinates,
    ...(edit?.noSidewalk ? { noSidewalk: true } : {}),
    slots,
  };
};

function catalogView(points) {
  const districts = new Map(), byId = new Map(), avdPoints = [], districtPoints = [];
  const avdFrames = new Map(), districtFrames = new Map();
  for (const point of points) {
    byId.set(point.id, point);
    const avd = isAvdSidewalkPoint(point);
    (avd ? avdPoints : districtPoints).push(point);
    if (!districts.has(point.district)) districts.set(point.district, []);
    districts.get(point.district).push(point);
    for (const slot of point.slots) (avd ? avdFrames : districtFrames).set(slot.id, point);
  }
  return { points, districts, byId, avdPoints, avdFrames, districtPoints, districtFrames };
}

// Исходный каталог неизменяем. Правки живут в постоянном томе фотослужбы.
export function createYardPathLayerRouter({ authenticate, boundary, pool, catalogPath = DEFAULT_CATALOG,
  editsPath = join(mediaRoot(), 'yard-paths', 'edits.json') }) {
  const router = express.Router();
  let catalog;
  let stored;
  let writes = Promise.resolve();
  const loadBaseCatalog = () => catalog ??= readFile(catalogPath, 'utf8').then(JSON.parse).then(indexCatalog).catch(error => {
    catalog = undefined;
    if (error.code === 'ENOENT') throw Object.assign(new Error('Тестовый слой ещё не загружен.'), { status: 503 });
    throw error;
  });
  const loadEdits = () => stored ??= readFile(editsPath, 'utf8').then(JSON.parse).then(entries => new Map(entries)).catch(error => {
    if (error.code === 'ENOENT') return new Map();
    stored = undefined;
    throw error;
  });
  const loadCatalog = async () => {
    const [base, edits] = await Promise.all([loadBaseCatalog(), loadEdits()]);
    const points = base.points.filter(point => !edits.get(point.id)?.deleted)
      .map(point => mergePoint(point, edits.get(point.id)));
    for (const [id, edit] of edits) {
      if (edit.createdPoint && !edit.deleted && !base.byId.has(id)) points.push(mergePoint(edit.createdPoint, edit));
    }
    if (base.singleFrame) {
      for (const point of points) {
        if (point.slots.length !== 1) throw new Error('Сохранённые правки несовместимы с каталогом ДТС.');
        point.singleFrame = true;
      }
    }
    return catalogView(points);
  };
  async function saveEdit(id, update) {
    const job = writes.then(async () => {
      const edits = new Map(await loadEdits());
      const previous = edits.get(id) || {};
      edits.set(id, update(previous));
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
      return edits.get(id);
    });
    writes = job.catch(() => {});
    return job;
  }
  const prefecture = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.user.role !== 'prefecture_admin') return res.status(403).json({ error: 'Этот обзор доступен только префектуре.' });
    next();
  };
  router.get('/', authenticate, prefecture, async (req, res, next) => {
    const { district } = req.query;
    if (!DISTRICTS.has(district)) return res.status(400).json({ error: 'Укажите район САО.' });
    try {
      const catalog = await loadCatalog();
      const photos = pool ? await loadSidewalkPhotos(pool) : new Map();
      res.json({ points: (catalog.districts.get(district) || []).map(point => ({
        ...point, slots: point.slots.map(slot => sidewalkSlotStatus(slot, photos.get(slot.id))),
      })) });
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

  // The photo router receives the effective catalog: new points/slots are active,
  // retired ones are hidden, and edit overlays have already been applied.
  const photos = { authenticate, pool, loadCatalog, loadEdits: async () => new Map(), mergePoint: point => point };
  
  router.use('/district', createAvdSidewalkPhotosRouter({ ...photos, scope: 'district' }));
  

  router.post('/', authenticate, prefecture, async (req, res, next) => {
    const { district, coordinates, azimuth } = req.body || {};
    if (!DISTRICTS.has(district) || !Array.isArray(coordinates) || coordinates.length !== 2
        || !coordinates.every(Number.isFinite) || coordinates[0] < 37.2 || coordinates[0] >= 37.8
        || coordinates[1] < 55.7 || coordinates[1] >= 56.05
        || (boundary && !isPointWithinBoundary(coordinates, boundary))) {
      return res.status(400).json({ error: 'Укажите район САО и точку внутри границ округа.' });
    }
    if (!Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360) {
      return res.status(400).json({ error: 'Укажите направление от 0° до 360° (не включая 360°).' });
    }
    try {
      const id = 'manual-' + randomUUID();
      const point = { id, district, balance: district, street: 'Добавлена вручную',
        sourceId: 'Добавлена вручную', taskId: 'Ручная точка', coordinates: [...coordinates],
        slots: [{ id: randomUUID(), azimuth }] };
      await saveEdit(id, () => ({ createdPoint: point }));
      res.status(201).json({ point: (await loadCatalog()).byId.get(id) });
    } catch (error) { next(error); }
  });

  router.post('/:pointId/slots', authenticate, prefecture, async (req, res, next) => {
    const { azimuth } = req.body || {};
    if (!Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360) {
      return res.status(400).json({ error: 'Укажите направление от 0° до 360° (не включая 360°).' });
    }
    try {
      const catalog = await loadCatalog();
      const point = catalog.byId.get(req.params.pointId);
      if (!point) return res.status(404).json({ error: 'Точка не найдена.' });
      if (point.singleFrame) return res.status(409).json({error: 'Для другого направления добавьте отдельную точку ДТС.'});
      if (point.slots.length >= 12) return res.status(409).json({ error: 'У точки уже 12 направлений.' });
      const slot = { id: randomUUID(), azimuth };
      await saveEdit(point.id, current => ({ ...current, addedSlots: [...(current.addedSlots || []), slot] }));
      res.status(201).json({ point: (await loadCatalog()).byId.get(point.id) });
    } catch (error) { next(error); }
  });

  router.delete('/:pointId/slots/:slotId', authenticate, prefecture, async (req, res, next) => {
    try {
      const catalog = await loadCatalog();
      const point = catalog.byId.get(req.params.pointId);
      if (!point || !point.slots.some(slot => slot.id === req.params.slotId)) {
        return res.status(404).json({ error: 'Точка или направление не найдены.' });
      }
      if (point.singleFrame) return res.status(409).json({error: 'Единственный кадр ДТС можно убрать вместе с точкой.'});
      await saveEdit(point.id, current => ({ ...current,
        removedSlots: [...new Set([...(current.removedSlots || []), req.params.slotId])] }));
      res.json({ point: (await loadCatalog()).byId.get(point.id), archived: true });
    } catch (error) { next(error); }
  });

  router.delete('/:pointId', authenticate, prefecture, async (req, res, next) => {
    try {
      const catalog = await loadCatalog();
      const point = catalog.byId.get(req.params.pointId);
      if (!point) return res.status(404).json({ error: 'Точка уже удалена или не найдена.' });
      await saveEdit(point.id, current => ({ ...current, deleted: true }));
      res.json({ deleted: true, archived: true });
    } catch (error) { next(error); }
  });

  router.patch('/:pointId', authenticate, async (req, res, next) => {
    const { coordinates, slotId, azimuth, noSidewalk } = req.body || {};
    const keys = Object.keys(req.body || {});
    const move = keys.length === 1 && keys[0] === 'coordinates';
    const rotate = keys.length === 2 && keys.includes('slotId') && keys.includes('azimuth');
    const mark = keys.length === 1 && keys[0] === 'noSidewalk' && typeof noSidewalk === 'boolean';
    const avd = false;
    const district = isDistrictSidewalkEditor(req.user);
    res.set('Cache-Control', 'private, no-store');
    if (req.user.role !== 'prefecture_admin' && !((avd || district) && mark)) {
      return res.status(403).json({ error: 'Геометрию и направления меняет только префектура.' });
    }
    if (move) {
      if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
          || coordinates[0] < 37.2 || coordinates[0] >= 37.8 || coordinates[1] < 55.7 || coordinates[1] >= 56.05
          || (boundary && !isPointWithinBoundary(coordinates, boundary))) {
        return res.status(400).json({ error: 'Точку можно передвинуть только в пределах САО.' });
      }
    } else if (!mark && (!rotate || typeof slotId !== 'string' || !Number.isFinite(azimuth) || azimuth < 0 || azimuth >= 360)) {
      return res.status(400).json({ error: 'Передайте координаты, ID слота с азимутом от 0 до 360° (не включая 360°) или пометку «Нет дорожки».' });
    }
    try {
      const { byId } = await loadCatalog();
      const point = byId.get(req.params.pointId);
      if (district && point && !districtOwnsSidewalk(req.user, point)) {
        return res.status(403).json({ error: 'Точка закреплена за другим исполнителем.' });
      }
      if (!point || (avd && !isAvdSidewalkPoint(point)) || (rotate && !point.slots.some(slot => slot.id === slotId))) {
        return res.status(404).json({ error: 'Точка или её фотослот не найдены.' });
      }
      await saveEdit(point.id, current => move ? { ...current, coordinates }
        : mark ? { ...current, noSidewalk }
          : { ...current, angles: { ...current.angles, [slotId]: azimuth } });
      res.json({ point: (await loadCatalog()).byId.get(point.id) });
    } catch (error) { next(error); }
  });
  return router;
}
