import { expect, test } from './fixtures.js';

const baseURL = 'http://127.0.0.1:8766/odh-map/';

test('client validation rejects a route whose endpoints are inside but the segment crosses a concave boundary', async ({ page }) => {
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

  expect(result.valid).toBe(false);
  expect(result.errors).toContain('Объект 1, сторона 1: пересекает границу САО.');
});

test('client validation rejects more than 2,000 coordinate points before reading the boundary', async ({ page }) => {
  await page.goto(`${baseURL}district-editor.html`);
  const result = await page.evaluate(() => {
    const coordinates = Array.from({ length: 2001 }, () => [0.5, 0.5]);
    const boundary = { features: [{ properties: { feature_kind: 'boundary_sao' }, get geometry() { throw new Error('Boundary should not be read'); } }] };
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

  expect(result.valid).toBe(false);
  expect(result.errors).toContain('В наборе не более 2000 координатных точек суммарно.');
});
