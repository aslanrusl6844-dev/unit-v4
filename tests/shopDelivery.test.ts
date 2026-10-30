import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFeeFor, deliveryFeeOfOrder, FREE_DELIVERY_FROM, DELIVERY_FEE } from '../src/config/shopDelivery';

test('доставка: меньше 10 000 ₸ — 1 000 ₸, от 10 000 ₸ — бесплатно', () => {
  assert.equal(FREE_DELIVERY_FROM, 10000);
  assert.equal(DELIVERY_FEE, 1000);
  assert.equal(deliveryFeeFor(1), 1000);
  assert.equal(deliveryFeeFor(1700), 1000);
  assert.equal(deliveryFeeFor(9999), 1000);
  assert.equal(deliveryFeeFor(10000), 0);
  assert.equal(deliveryFeeFor(13500), 0);
});

test('доставка: пустая или некорректная сумма не даёт платной доставки', () => {
  assert.equal(deliveryFeeFor(0), 0);
  assert.equal(deliveryFeeFor(-5), 0);
  assert.equal(deliveryFeeFor(Number.NaN), 0);
});

test('доставка в готовом заказе: итог минус позиции, старые заказы — 0', () => {
  assert.equal(deliveryFeeOfOrder(2700, [{ price: 1700, quantity: 1 }]), 1000);
  assert.equal(deliveryFeeOfOrder(13500, [{ price: 13500, quantity: 1 }]), 0);
  assert.equal(deliveryFeeOfOrder(1000, [{ price: 1500, quantity: 1 }]), 0);
  assert.equal(deliveryFeeOfOrder(500, []), 500);
});
