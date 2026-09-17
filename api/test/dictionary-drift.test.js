// Дрейф словаря: api и браузер держат каждый свою копию словаря типов.
// district-changes.js — браузерный IIFE над window, чистым ES-модулем он не
// грузится, поэтому api не может его импортировать. Вместо общего импорта
// сторож читает исходник district-changes.js, разбирает из него словарь TYPES и
// ROUTE_TYPES и сверяет поле в поле с копиями api. Любое расхождение — падение
// теста, а не молчаливо разъехавшиеся отчёты.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ROUTE_TYPES, ZONE_TYPES, groupOf } from '../lib/route-report.js';
import { TYPES as API_TYPES } from '../lib/validation.js';

// Исходник читаем с нормализованными переводами строк: файл лежит в CRLF, а
// разбор опирается на границы строк.
const source = fs.readFileSync(new URL('../../odh-map/district-changes.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Разбирает словарь TYPES из браузерного исходника: ключ типа и его geometry/group.
function browserTypes(text) {
  const block = text.slice(text.indexOf('const TYPES = {'), text.indexOf('const ROUTE_TYPES ='));
  const types = {};
  for (const match of block.matchAll(/^ {4}([a-z_]+): \{([\s\S]*?)\n {4}\},?(?=\n)/gm)) {
    const [, key, body] = match;
    types[key] = {
      geometry: body.match(/geometry: '([A-Za-z]+)'/)?.[1],
      group: body.match(/group: '([a-z]+)'/)?.[1]
    };
  }
  return types;
}

function browserRouteTypes(text) {
  const match = text.match(/const ROUTE_TYPES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, 'в district-changes.js найден ROUTE_TYPES');
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]));
}

test('словарь типов api совпадает с браузерным district-changes.js', () => {
  const browser = browserTypes(source);
  // Защита от тихого отказа разбора: словарь заведомо не пустой.
  assert.ok(Object.keys(browser).length >= 5, `разобрано типов: ${Object.keys(browser).length}`);
  for (const [key, type] of Object.entries(browser)) {
    assert.ok(type.geometry && type.group, `у типа ${key} есть geometry и group`);
  }

  // 1. Список типов и их геометрия совпадают с validation.TYPES.
  assert.deepEqual(Object.keys(API_TYPES).sort(), Object.keys(browser).sort(), 'список типов');
  for (const [key, type] of Object.entries(browser)) {
    assert.equal(API_TYPES[key], type.geometry, `геометрия типа ${key}`);
  }

  // 2. Группа в отчёте совпадает с group в браузерном словаре — поле в поле.
  for (const [key, type] of Object.entries(browser)) {
    assert.equal(groupOf(key), type.group, `группа типа ${key}`);
  }

  // 3. Наборы маршрутов и зон в api равны группам браузерного словаря.
  const routeKeys = new Set(Object.entries(browser).filter(([, type]) => type.group === 'route').map(([key]) => key));
  const zoneKeys = new Set(Object.entries(browser).filter(([, type]) => type.group === 'zone').map(([key]) => key));
  assert.deepEqual([...ROUTE_TYPES].sort(), [...browserRouteTypes(source)].sort(), 'ROUTE_TYPES api и браузера');
  assert.deepEqual([...ROUTE_TYPES].sort(), [...routeKeys].sort(), 'ROUTE_TYPES против group=route');
  assert.deepEqual([...ZONE_TYPES].sort(), [...zoneKeys].sort(), 'ZONE_TYPES против group=zone');

  // 4. Тип вне словаря в отчёте попадает в точки — как и обещает комментарий.
  assert.equal(groupOf('unknown_future_type'), 'point');
});
