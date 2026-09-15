import { expect, test } from './fixtures.js';

test('GeoJSON overlay renders cleaning routes solid and rotor transfers dotted', async ({ page }) => {
  await page.goto('http://127.0.0.1:8766/odh-map/');
  const route = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[37.5435, 55.7998], [37.5442, 55.8003], [37.5449, 55.8008]],
        },
        properties: { change_type: 'queue', queue_priority: '1', name: 'Synthetic cleaning route test' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[37.5455, 55.8012], [37.5462, 55.8017], [37.5469, 55.8022]],
        },
        properties: { change_type: 'rotor_transfer', name: 'Synthetic rotor transfer test' },
      },
    ],
  };

  await page.locator('#overlay-input').setInputFiles({
    name: 'airport-route-test.geojson',
    mimeType: 'application/geo+json',
    buffer: Buffer.from(JSON.stringify(route)),
  });

  await expect(page.locator('#overlay-note')).toContainText('Наложено объектов: 2');
  const overlayStyle = await page.evaluate(() => {
    const styles = {};
    overlayLayer.eachLayer((layer) => {
      styles[layer.feature.properties.change_type] = layer.options.dashArray ?? null;
    });
    return styles;
  });
  expect(overlayStyle).toEqual({ queue: null, rotor_transfer: '4 9' });
});
