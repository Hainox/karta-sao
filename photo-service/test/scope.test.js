import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTODOR_OBJECT_SQL, isAutodorAccount, isAutodorHolder, objectAllowedFor } from '../src/scope.js';

const autodorUser = { role: 'district_editor', district: 'АвД САО' };
const districtUser = { role: 'district_editor', district: 'Аэропорт' };
const prefecture = { role: 'prefecture_admin', district: null };

test('учётка АвД узнаётся по названию без учёта регистра', () => {
  assert.equal(isAutodorAccount('АвД САО'), true);
  assert.equal(isAutodorAccount(' авд сао '), true);
  assert.equal(isAutodorAccount('Аэропорт'), false);
  assert.equal(isAutodorAccount(null), false);
});

test('владельцем считаются АвД САО и ДЭУ', () => {
  assert.equal(isAutodorHolder('АвД САО'), true);
  assert.equal(isAutodorHolder('ДЭУ 1'), true);
  assert.equal(isAutodorHolder('дэу 3'), true);
  assert.equal(isAutodorHolder('Жилищник Беговой'), false);
  assert.equal(isAutodorHolder('#N/A'), false);
  assert.equal(isAutodorHolder(null), false);
});

test('учётка АвД работает со своими объектами в любом районе', () => {
  // АвД-объект стоит в Аэропорту, но ведёт его АвД.
  assert.equal(objectAllowedFor(autodorUser, { district: 'Аэропорт', balance_holder: 'АвД САО' }), true);
  // Переходы ДЭУ тоже уходят АвД.
  assert.equal(objectAllowedFor(autodorUser, { district: 'Коптево', balance_holder: 'ДЭУ 2' }), true);
  // Объект без района приписать району нельзя — он тоже у АвД.
  assert.equal(objectAllowedFor(autodorUser, { district: null, balance_holder: null }), true);
  // А объекты жилищников — нет.
  assert.equal(objectAllowedFor(autodorUser, { district: 'Беговой', balance_holder: 'Жилищник Беговой' }), false);
});

test('районная учётка видит только свой район, префектура — всё', () => {
  assert.equal(objectAllowedFor(districtUser, { district: 'Аэропорт', balance_holder: 'АвД САО' }), true);
  assert.equal(objectAllowedFor(districtUser, { district: 'Коптево', balance_holder: 'АвД САО' }), false);
  assert.equal(objectAllowedFor(districtUser, { district: null, balance_holder: null }), false);
  assert.equal(objectAllowedFor(prefecture, { district: 'Коптево', balance_holder: 'Жилищник Коптево' }), true);
});

test('условие выборки АвД покрывает свои объекты, ДЭУ и объекты без района', () => {
  assert.match(AUTODOR_OBJECT_SQL, /o\.district IS NULL/);
  assert.match(AUTODOR_OBJECT_SQL, /'АвД САО'/);
  assert.match(AUTODOR_OBJECT_SQL, /ILIKE 'ДЭУ%'/);
});
