// Дашборд округа для каталога карт (хаба). Три ручки:
//   GET /dashboard/summary — открытая сводка по оцифровкам САО (без районов и фото);
//   GET /dashboard/details — префектуре: разрез по районам и лента последних действий;
//   GET /dashboard/news    — новости округа: лента сайта префектуры САО, иначе mos.ru.
// Ответы кешируются в памяти: хаб открывают часто, а запросы к базе тяжёлые.
import express from 'express';
import { DISTRICTS } from './tpu-points/validation.js';
import { PREFECTURE_ARCHIVE_CUTOFF } from './tpu-points/district-point-photos.js';
import { createSlotRepository, objectsWithSlotCounts, slotSummary } from './tpu-points/object-slots.js';
import { loadReportRows, reportPayload } from './reports.js';

const SLOT_DATASET = 'sao_tpu_parking';
// Ленты по порядку: первая, что ответила и дала новости, идёт на дашборд.
// SAO_NEWS_URLS (через запятую) заменяет список, если у сайта префектуры другой адрес.
export const DEFAULT_NEWS_URLS = [
  'https://sao.mos.ru/presscenter/news/rss/',
  'https://sao.mos.ru/rss/',
  'https://sao.mos.ru/presscenter/news/',
  'https://www.mos.ru/rss',
];

const ENTRANCE_STATES = `SELECT p.district,
    CASE
      WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'pending') THEN 'review'
      WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'accepted') THEN 'done'
      WHEN EXISTS (SELECT 1 FROM object_photo_point_photos f WHERE f.point_id = p.id AND f.status = 'rejected') THEN 'rework'
      ELSE 'empty'
    END AS state
  FROM object_photo_points p
  WHERE p.dataset_id = 'sao_district_photo_points' AND p.retired_at IS NULL
    AND p.created_at >= ${PREFECTURE_ARCHIVE_CUTOFF} AND COALESCE(p.note, '') NOT LIKE 'Источник:%'`;

const slotStateSql = (table) => `COALESCE(
    (SELECT CASE f.status WHEN 'accepted' THEN 'done' ELSE 'review' END FROM ${table} f
      WHERE f.point_id = p.id AND f.status IN ('pending', 'accepted') ORDER BY f.uploaded_at DESC LIMIT 1),
    (SELECT 'rework' FROM ${table} f WHERE f.point_id = p.id AND f.status = 'rejected' LIMIT 1),
    'empty') AS state`;

const PLAYGROUND_STATES = `SELECT p.district, ${slotStateSql('playground_photo_slot_photos')}
  FROM playground_photo_points p JOIN playground_photo_slots s ON s.point_id = p.id`;
const SIDEWALK_STATES = `SELECT p.district, ${slotStateSql('sidewalk_photo_slot_photos')}
  FROM sidewalk_photo_points p WHERE p.retired_at IS NULL`;

const TPU_STATE = { closed: 'done', review: 'review', progress: 'progress', rework: 'rework', empty: 'empty' };

/** Счётчики по состояниям: готово, на проверке, в работе, на доработке, нет фото. */
export function tally(states) {
  const counts = { total: 0, done: 0, review: 0, progress: 0, rework: 0, empty: 0 };
  for (const state of states) {
    counts[state in counts && state !== 'total' ? state : 'empty'] += 1;
    counts.total += 1;
  }
  return counts;
}

/** Те же счётчики, разложенные по районам САО (прочие группы — отдельными строками). */
export function tallyByDistrict(rows) {
  const groups = new Map();
  for (const { district, state } of rows) {
    const key = district || 'Без района';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(state);
  }
  const order = [...DISTRICTS];
  return [...groups.entries()]
    .map(([district, states]) => ({ district, ...tally(states) }))
    .sort((a, b) => (order.indexOf(a.district) + 1 || 99) - (order.indexOf(b.district) + 1 || 99) || a.district.localeCompare(b.district, 'ru'));
}

const ACTIONS = {
  photo_uploaded: 'загружено фото фотофиксации',
  photo_rejected: 'фото фотофиксации возвращено на доработку',
  photo_withdrawn: 'фото фотофиксации отозвано',
  photo_deleted: 'фото фотофиксации удалено',
  object_photo_point_created: 'поставлена точка съёмки въездной группы',
  object_photo_point_updated: 'изменена точка съёмки въездной группы',
  object_photo_point_retired: 'снята точка съёмки въездной группы',
  object_photo_point_photo_uploaded: 'загружено фото въездной группы',
  object_photo_point_photo_deleted: 'удалено фото въездной группы',
  district_point_photo_reviewed: 'проверено фото въездной группы',
  playground_photo_uploaded: 'загружено фото площадки ДП/СП',
  playground_photo_reviewed: 'проверено фото площадки ДП/СП',
  sidewalk_point_create: 'поставлена точка съёмки тротуара',
  sidewalk_point_update: 'изменена точка съёмки тротуара',
  sidewalk_point_retire: 'снята точка съёмки тротуара',
  sidewalk_photo_uploaded: 'загружено фото тротуара',
  sidewalk_photo_reviewed: 'проверено фото тротуара',
  sidewalk_photo_removed: 'удалено фото тротуара',
  object_slot_photo_uploaded: 'загружено фото ТПУ или парковки',
  object_slot_photo_reviewed: 'проверено фото ТПУ или парковки',
  object_slot_count_changed: 'изменено число слотов ТПУ или парковки',
  mkd_photo_uploaded: 'загружено фото первого этажа МКД',
  mkd_photo_deleted: 'удалено фото первого этажа МКД',
  district_direction_corrected: 'исправлено направление на карте района',
};

/** Строка ленты «что сейчас делается»: кто, что и когда — без служебных полей журнала. */
export function activityItem(row) {
  const who = row.role === 'prefecture_admin' ? 'Префектура' : row.district || row.display_name || 'Учётная запись';
  const decision = row.metadata?.decision === 'rejected' ? ' — на доработку' : row.metadata?.decision === 'accepted' ? ' — принято' : '';
  return { at: row.created_at, who, what: (ACTIONS[row.action] || 'действие в фотослужбе') + decision };
}

const decode = (text) => String(text || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

/**
 * Новости из RSS (<item>) или, если это страница, из ссылок на новости (/news/…).
 * Возвращает до limit записей { title, link, date } только с адресами mos.ru.
 */
export function parseNews(text, baseUrl, limit = 6) {
  const items = [];
  const safeLink = (href) => {
    try {
      const url = new URL(decode(href), baseUrl);
      return url.protocol === 'https:' && /(^|\.)mos\.ru$/.test(url.hostname) ? url.href : null;
    } catch { return null; }
  };
  for (const [, body] of String(text).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const title = decode(body.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const link = safeLink(body.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '');
    const pub = body.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const date = pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null;
    if (title && link) items.push({ title, link, date });
    if (items.length >= limit) return items;
  }
  if (items.length) return items;
  const seen = new Set();
  for (const [, href, inner] of String(text).matchAll(/<a\b[^>]*href="([^"]*\/news\/[^"]*\d[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const title = decode(inner);
    const link = safeLink(href);
    if (!link || title.length < 20 || seen.has(link)) continue;
    seen.add(link);
    items.push({ title, link, date: null });
    if (items.length >= limit) break;
  }
  return items;
}

function cached(ttlMs, load) {
  let value = null;
  let at = 0;
  let pending = null;
  return async () => {
    if (value && Date.now() - at < ttlMs) return value;
    pending = pending || load().then((next) => { value = next; at = Date.now(); return next; }).finally(() => { pending = null; });
    return pending;
  };
}

export function createDashboardApp({ pool, currentUser, fetchImpl = fetch, newsUrls = DEFAULT_NEWS_URLS, now = () => new Date() }) {
  const slots = createSlotRepository(pool, async () => { throw new Error('read only'); });
  const states = async (sql) => (await pool.query(sql)).rows;

  async function tpuRows() {
    const objects = objectsWithSlotCounts(await slots.listSlotCounts());
    const summary = new Map(slotSummary(await slots.listSlotPhotos({ datasetId: SLOT_DATASET }), objects).map((row) => [row.object_key, row.status]));
    return [...objects.entries()].map(([key, object]) => ({ district: object.group, state: TPU_STATE[summary.get(key) || 'empty'] }));
  }

  async function photoFixation() {
    const payload = reportPayload(await loadReportRows(pool, { role: 'prefecture_admin' }));
    const o = payload.overall;
    const review = Math.min(o.pendingReviewObjects, o.totalObjects - o.completedObjects);
    return {
      total: o.totalObjects, done: o.completedObjects, review,
      progress: Math.max(0, o.objectsWithPhoto - o.completedObjects - review), rework: 0, empty: o.objectsWithoutPhoto,
    };
  }

  const summary = cached(60_000, async () => {
    const [entrances, playgrounds, tpu, fixation] = await Promise.all([
      states(ENTRANCE_STATES), states(PLAYGROUND_STATES), tpuRows(), photoFixation().catch(() => null),
    ]);
    const rows = [
      { key: 'entrances', label: 'Въездные группы', href: '../districts/', ...tally(entrances.map((r) => r.state)) },
      { key: 'playgrounds', label: 'Площадки ДП/СП', href: '../districts/', ...tally(playgrounds.map((r) => r.state)) },
      { key: 'tpu', label: 'ТПУ и парковки', href: '../object-maps/tpu-parking.html', ...tally(tpu.map((r) => r.state)) },
    ];
    if (fixation) rows.push({ key: 'fixation', label: 'Остановки, ПП, подъезды', href: '../object-maps/', ...fixation });
    return { updatedAt: now().toISOString(), digitizations: rows };
  });

  const details = cached(60_000, async () => {
    const [entrances, playgrounds, sidewalks, tpu, activity] = await Promise.all([
      states(ENTRANCE_STATES), states(PLAYGROUND_STATES), states(SIDEWALK_STATES), tpuRows(),
      pool.query(`SELECT a.action, a.metadata, a.created_at, u.role, u.district, u.display_name
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.created_at > now() - interval '7 days' ORDER BY a.created_at DESC LIMIT 25`).then((r) => r.rows),
    ]);
    return {
      updatedAt: now().toISOString(),
      byDistrict: {
        entrances: tallyByDistrict(entrances), playgrounds: tallyByDistrict(playgrounds),
        sidewalks: tallyByDistrict(sidewalks), tpu: tallyByDistrict(tpu),
      },
      activity: activity.map(activityItem),
    };
  });

  const news = cached(20 * 60_000, async () => {
    for (const url of newsUrls) {
      try {
        const response = await fetchImpl(url, { headers: { 'User-Agent': 'sao-atlas-dashboard/1.0' }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) continue;
        const items = parseNews(await response.text(), url);
        if (items.length) return { source: new URL(url).hostname, items, fetchedAt: now().toISOString() };
      } catch { /* следующая лента */ }
    }
    return { source: null, items: [], fetchedAt: now().toISOString() };
  });

  const app = express();
  app.disable('x-powered-by');
  const send = (load, cacheSeconds) => async (req, res, next) => {
    try {
      res.set('Cache-Control', `public, max-age=${cacheSeconds}`).json(await load());
    } catch (error) { next(error); }
  };
  app.get('/dashboard/summary', send(summary, 60));
  app.get('/dashboard/news', send(news, 600));
  app.get('/dashboard/details', async (req, res, next) => {
    try {
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: 'Войдите учётной записью префектуры.' });
      if (user.role !== 'prefecture_admin') return res.status(403).json({ error: 'Подробная сводка доступна префектуре.' });
      res.set('Cache-Control', 'private, no-store').json(await details());
    } catch (error) { next(error); }
  });
  app.use((error, _req, res, _next) => {
    console.error('dashboard', error);
    res.status(500).json({ error: 'Сводка временно недоступна.' });
  });
  return app;
}
