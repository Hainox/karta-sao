import assert from 'node:assert/strict';
import test from 'node:test';
import { activityItem, createDashboardApp, parseNews, tally, tallyByDistrict } from '../src/dashboard.js';

test('сводка считает готово, на проверке, в работе, на доработке и без фото', () => {
  assert.deepEqual(tally(['done', 'review', 'empty', 'rework', 'progress', 'странное']),
    { total: 6, done: 1, review: 1, progress: 1, rework: 1, empty: 2 });
});

test('разрез по районам идёт в порядке районов САО, прочие группы — в конце', () => {
  const rows = tallyByDistrict([
    { district: 'АвД САО', state: 'done' }, { district: 'Сокол', state: 'empty' },
    { district: 'Аэропорт', state: 'review' }, { district: null, state: 'empty' },
  ]);
  assert.deepEqual(rows.map((r) => r.district), ['Аэропорт', 'Сокол', 'АвД САО', 'Без района']);
  assert.equal(rows[0].review, 1);
});

test('лента действий говорит по-русски, кто и что сделал', () => {
  assert.deepEqual(activityItem({ action: 'sidewalk_photo_reviewed', metadata: { decision: 'rejected' }, created_at: 't', role: 'prefecture_admin' }),
    { at: 't', who: 'Префектура', what: 'проверено фото тротуара — на доработку' });
  assert.equal(activityItem({ action: 'playground_photo_uploaded', metadata: {}, created_at: 't', role: 'district_editor', district: 'Коптево' }).who, 'Коптево');
  assert.equal(activityItem({ action: 'unknown', metadata: {}, created_at: 't' }).what, 'действие в фотослужбе');
});

test('новости читаются из RSS и со страницы, ссылки только на mos.ru', () => {
  const rss = `<rss><channel><item><title>В САО &laquo;обновили&raquo; дворы</title><link>https://sao.mos.ru/presscenter/news/detail/1.html</link>
    <pubDate>Thu, 29 Oct 2026 11:30:01 +0300</pubDate></item><item><title>Чужая ссылка</title><link>https://evil.example/x</link></item></channel></rss>`;
  assert.deepEqual(parseNews(rss, 'https://sao.mos.ru/rss/'), [
    { title: 'В САО «обновили» дворы', link: 'https://sao.mos.ru/presscenter/news/detail/1.html', date: '2026-10-29T08:30:01.000Z' },
  ]);
  const page = '<a href="/presscenter/news/detail/12345.html"><span>На улице Острякова обновляют жилой дом</span></a><a href="/presscenter/news/detail/12345.html">дубль ссылки на ту же новость</a><a href="/about/">О префектуре</a>';
  assert.deepEqual(parseNews(page, 'https://sao.mos.ru/presscenter/news/'), [
    { title: 'На улице Острякова обновляют жилой дом', link: 'https://sao.mos.ru/presscenter/news/detail/12345.html', date: null },
  ]);
});

function call(app, path, headers = {}) {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
      const body = await response.json();
      server.close();
      resolve({ status: response.status, body });
    });
  });
}

test('подробная сводка — только префектуре; новости берутся из первой отвечающей ленты', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const users = { pref: { role: 'prefecture_admin' }, district: { role: 'district_editor', district: 'Сокол' } };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.includes('first')) return { ok: false, text: async () => '' };
    return { ok: true, text: async () => '<item><title>Новость округа</title><link>https://www.mos.ru/news/item/1/</link></item>' };
  };
  const app = createDashboardApp({ pool, currentUser: async (req) => users[req.headers['x-test-user']] || null, fetchImpl,
    newsUrls: ['https://sao.mos.ru/first', 'https://www.mos.ru/rss'] });
  assert.equal((await call(app, '/dashboard/details')).status, 401);
  assert.equal((await call(app, '/dashboard/details', { 'x-test-user': 'district' })).status, 403);
  const details = await call(app, '/dashboard/details', { 'x-test-user': 'pref' });
  assert.equal(details.status, 200);
  assert.deepEqual(Object.keys(details.body.byDistrict), ['entrances', 'playgrounds', 'sidewalks', 'tpu']);
  const news = await call(app, '/dashboard/news');
  assert.equal(news.body.source, 'www.mos.ru');
  assert.equal(news.body.items[0].title, 'Новость округа');
  assert.deepEqual(fetched, ['https://sao.mos.ru/first', 'https://www.mos.ru/rss']);
});
