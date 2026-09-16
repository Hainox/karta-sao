import assert from 'node:assert/strict';
import test from 'node:test';
import { clientAddress } from '../src/client-address.js';

test('берёт последний адрес цепочки: его дописал прокси', () => {
  assert.equal(clientAddress({ 'x-forwarded-for': '203.0.113.7, 10.1.2.3' }, '172.18.0.9'), '10.1.2.3');
});

test('один адрес в заголовке', () => {
  assert.equal(clientAddress({ 'x-forwarded-for': '203.0.113.7' }, '172.18.0.9'), '203.0.113.7');
});

test('без заголовка остаётся адрес сокета', () => {
  assert.equal(clientAddress({}, '172.18.0.9'), '172.18.0.9');
  assert.equal(clientAddress({}, null), 'unknown');
});

test('пустой заголовок не подменяет адрес сокета', () => {
  assert.equal(clientAddress({ 'x-forwarded-for': '   ' }, '172.18.0.9'), '172.18.0.9');
});
