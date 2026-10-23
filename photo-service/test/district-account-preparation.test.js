import assert from 'node:assert/strict';
import test from 'node:test';
import { districtMapUrl, generateDistrictPassword, DISTRICT_SLUGS } from '../scripts/prepare-district-map-accounts.js';

test('ссылки для выдачи доступа ведут на соответствующую карту каждого района', () => {
  assert.equal(Object.keys(DISTRICT_SLUGS).length, 16);
  assert.equal(districtMapUrl('Аэропорт'), 'https://hainox.github.io/karta-sao/districts/aeroport.html');
  assert.equal(districtMapUrl('Хорошевский', 'https://example.test/'), 'https://example.test/districts/horoshevskiy.html');
  assert.throws(() => districtMapUrl('Не район'), /Неизвестный район/);
});

test('пароль новой районной учётки уникального формата и длины', () => {
  const password = generateDistrictPassword();
  assert.match(password, /^[23456789abcdefghjkmnpqrstuvwxyz]{4}(-[23456789abcdefghjkmnpqrstuvwxyz]{4}){3}$/);
  assert.equal(password.length, 19);
});
