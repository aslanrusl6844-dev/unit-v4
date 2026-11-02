import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const { parseAppItems, sameCity } = require('../src/routes/wholesalers.routes');

test('позиции заказа приложения из JSON', () => {
  assert.deepEqual(parseAppItems('[{"sku":"123","name":"Крем","price":100,"quantity":2},{"name":"без sku"}]'), [{ sku: '123', name: 'Крем', quantity: 2 }]);
  assert.deepEqual(parseAppItems('битый'), []);
  assert.deepEqual(parseAppItems([{ sku: 5, qty: 3 }]), [{ sku: '5', name: '', quantity: 3 }]);
});

test('город сравнивается без регистра и ё', () => {
  assert.equal(sameCity('Алматы', ' алматы '), true);
  assert.equal(sameCity('Семёй', 'Семей'), true);
  assert.equal(sameCity('Астана', 'Алматы'), false);
});
