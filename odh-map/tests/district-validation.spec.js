import { expect, test } from './fixtures.js';

const baseURL = 'http://127.0.0.1:8766/odh-map/';

test('client validation allows a route to cross and leave the SAO boundary', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  const result = await page.evaluate(() => {
    const boundary = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { feature_kind: 'boundary_sao' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]]]
        }
      }]
    };
    const coordinates = [[0.5, 3.5], [3.5, 0.5]];
    const changeSet = {
      type: 'FeatureCollection',
      change_set_version: 'district_change_set_v2',
      district: 'Аэропорт',
      author: 'Тест',
      features: [{
        type: 'Feature',
        properties: {
          change_type: 'queue', queue_priority: '1', district: 'Аэропорт', author: 'Тест',
          address: 'Синтетическая проверка', route_start: coordinates[0], route_end: coordinates[1],
          route_direction: 'start_to_end', nozzle_direction: 'both'
        },
        geometry: { type: 'LineString', coordinates }
      }]
    };
    return DistrictChanges.validate(changeSet, boundary);
  });

  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test('client validation allows routes with more than 2,000 coordinate points', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  const result = await page.evaluate(() => {
    const coordinates = Array.from({ length: 2001 }, () => [0.5, 0.5]);
    const boundary = { type: 'FeatureCollection', features: [] };
    const changeSet = {
      type: 'FeatureCollection',
      change_set_version: 'district_change_set_v2',
      district: 'Аэропорт',
      author: 'Тест',
      features: [{
        type: 'Feature',
        properties: {
          change_type: 'queue', queue_priority: '1', district: 'Аэропорт', author: 'Тест',
          address: 'Синтетическая проверка', route_start: coordinates[0], route_end: coordinates.at(-1),
          route_direction: 'start_to_end', nozzle_direction: 'both'
        },
        geometry: { type: 'LineString', coordinates }
      }]
    };
    return DistrictChanges.validate(changeSet, boundary);
  });

  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test('client validation flags the same route drawn twice, including reversed direction', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  const result = await page.evaluate(() => {
    const coordinates = [[0.5, 0.5], [1, 1], [1.5, 1.5]];
    const feature = {
      type: 'Feature',
      properties: {
        change_type: 'queue', queue_priority: '1', district: 'Аэропорт', author: 'Тест',
        address: 'Синтетический маршрут', route_start: coordinates[0], route_end: coordinates.at(-1),
        route_direction: 'start_to_end', nozzle_direction: 'both'
      },
      geometry: { type: 'LineString', coordinates }
    };
    return DistrictChanges.validate({
      type: 'FeatureCollection', change_set_version: 'district_change_set_v2', district: 'Аэропорт', author: 'Тест',
      features: [feature, { ...feature, geometry: { type: 'LineString', coordinates: [...coordinates].reverse() } }]
    }, { type: 'FeatureCollection', features: [] });
  });

  expect(result.valid).toBe(false);
  expect(result.errors.join('\n')).toContain('дублирует маршрут 1');
});

test('сообщение об ошибке называет объект по номеру и типу, а не по позиции в файле', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  const result = await page.evaluate(() => {
    const coordinates = [[1, 1], [2, 2]];
    const changeSet = {
      type: 'FeatureCollection',
      change_set_version: 'district_change_set_v2',
      district: 'Аэропорт',
      author: 'Тест',
      features: [{
        type: 'Feature',
        properties: {
          change_type: 'dkm_route_yards', district: 'Аэропорт', author: 'Тест',
          address: 'Дмитровское шоссе, у д. 90', object_no: 7,
          route_start: coordinates[0], route_end: coordinates[1],
          route_direction: 'start_to_end', nozzle_direction: 'both'
        },
        geometry: { type: 'LineString', coordinates }
      }]
    };
    // Граница не нужна: проверка типа идёт раньше обхода контура.
    return DistrictChanges.validate(changeSet, { features: [] });
  });

  expect(result.valid).toBe(false);
  expect(result.errors).toContain('Объект 7 (Дмитровское шоссе, у д. 90): тип «dkm_route_yards» больше не поддерживается. Удалите объект и нарисуйте его заново.');
});
