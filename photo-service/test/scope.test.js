import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTODOR_OBJECT_SQL, districtMatchSql, districtScopeSql, isAutodorAccount, isAutodorHolder, objectAllowedFor, sameDistrict } from '../src/scope.js';

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

test('районная учётка видит только свои объекты, префектура — всё', () => {
  // Объект «АвД САО» стоит в Аэропорту, но ведёт его АвД: район его не снимает.
  assert.equal(objectAllowedFor(districtUser, { district: 'Аэропорт', balance_holder: 'АвД САО' }), false);
  assert.equal(objectAllowedFor(districtUser, { district: 'Аэропорт', balance_holder: 'ДЭУ 1' }), false);
  assert.equal(objectAllowedFor(districtUser, { district: 'Аэропорт', balance_holder: 'Жилищник Аэропорт' }), true);
  assert.equal(objectAllowedFor(districtUser, { district: 'Аэропорт', balance_holder: null }), true);
  assert.equal(objectAllowedFor(districtUser, { district: 'Коптево', balance_holder: 'АвД САО' }), false);
  assert.equal(objectAllowedFor(districtUser, { district: null, balance_holder: null }), false);
  assert.equal(objectAllowedFor(prefecture, { district: 'Коптево', balance_holder: 'Жилищник Коптево' }), true);
  assert.equal(objectAllowedFor(prefecture, { district: 'Коптево', balance_holder: 'АвД САО' }), true);
});

test('выборка района исключает объекты АвД и ДЭУ', () => {
  const sql = districtScopeSql('$1');
  // Район совпадает…
  assert.match(sql, /lower\(btrim/);
  assert.match(sql, /\$1/);
  // …и владелец не АвД/ДЭУ.
  assert.match(sql, /AND NOT/);
  assert.match(sql, /'АвД САО'/);
  assert.match(sql, /ILIKE 'ДЭУ%'/);
  // Объекты без района к району не относятся вовсе — отдельного условия не нужно.
  assert.doesNotMatch(sql, /o\.district IS NULL/);
});

test('условие выборки АвД покрывает свои объекты, ДЭУ и объекты без района', () => {
  assert.match(AUTODOR_OBJECT_SQL, /o\.district IS NULL/);
  assert.match(AUTODOR_OBJECT_SQL, /'АвД САО'/);
  assert.match(AUTODOR_OBJECT_SQL, /ILIKE 'ДЭУ%'/);
});

test('район учётки и район объекта сравниваются без учёта регистра, пробелов и «ё»', () => {
  assert.equal(sameDistrict('Молжаниновский', 'молжаниновский'), true);
  assert.equal(sameDistrict(' Молжаниновский ', 'Молжаниновский'), true);
  assert.equal(sameDistrict('Восточное Дегунино', 'Восточное Дегунино'), true);
  assert.equal(sameDistrict('Хорошевский', 'Хорошевский'), true);
  assert.equal(sameDistrict('Коптево', 'Сокол'), false);
  assert.equal(sameDistrict('', ''), false);
  assert.equal(sameDistrict(null, 'Сокол'), false);
});

test('учётка с другим написанием района всё равно видит свои объекты', () => {
  // Район учётки вводит администратор, район объекта приходит из границ:
  // расхождение в регистре раньше давало вход без данных.
  const lowercaseUser = { role: 'district_editor', district: 'молжаниновский' };
  assert.equal(objectAllowedFor(lowercaseUser, { district: 'Молжаниновский', balance_holder: null }), true);
  assert.equal(objectAllowedFor(lowercaseUser, { district: 'Коптево', balance_holder: null }), false);
});

test('условие выборки по району в SQL сравнивает так же мягко', () => {
  const sql = districtMatchSql('$1');
  assert.match(sql, /lower\(btrim/);
  assert.match(sql, /replace\(/);
  assert.match(sql, /\$1/);
});
