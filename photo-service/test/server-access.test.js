import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// server.js поднимает сокет уже при импорте, и без PostgreSQL его ручки не
// запустить, поэтому правила доступа к объекту проверяются по исходнику: все
// объектные ручки обязаны считать доступ функцией objectAllowedFor. Иначе
// учётка «АвД САО» снова получит 404 на своих объектах в чужих районах и на
// объектах без района — как было при прямом сравнении с районом учётки.
const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('доступ к объекту во всех ручках считается одной функцией', () => {
  // Загрузка фото, галерея точки и поиск зарегистрированных точек.
  const calls = source.match(/objectAllowedFor\(/g) || [];
  assert.ok(calls.length >= 3, `objectAllowedFor вызывается ${calls.length} раз`);
  // Правило живёт в src/scope.js: у учётки АвД свои объекты, «ДЭУ» и объекты без района.
  assert.match(source, /import \{[^}]*objectAllowedFor[^}]*\} from '\.\/src\/scope\.js'/);
});

test('ручки объекта не сравнивают район учётки напрямую', () => {
  assert.ok(!/district !== user\.district/.test(source), 'сравнение района в обход objectAllowedFor');
  assert.ok(!/row\.district === user\.district/.test(source), 'сравнение района в обход objectAllowedFor');
});

test('префектура видит возвращённые кадры и на карте, и в карточке проверки', () => {
  // Возвращённый кадр остаётся доступен префектуре для повторной проверки и
  // загрузки файла, а summary обязан передать его на карту как «На доработке».
  assert.match(source, /const reviewFilter = user\.role === 'prefecture_admin' \|\| user\.role === 'district_editor' \? "p\.review_status <> 'withdrawn'/);
  const summaryBlock = source.match(/if \(pathname === '\/reports\/summary'[\s\S]*?return sendJson/);
  assert.ok(summaryBlock, 'ручка сводки не найдена');
  assert.match(summaryBlock[0], /includeRejected: user\.role === 'district_editor' \|\| user\.role === 'prefecture_admin'/);
});
