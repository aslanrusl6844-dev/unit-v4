/**
 * Тесты разбора заказов Teez (чистые функции, без сети и БД):
 * статусы, деньги, частичный возврат, склейка позиций одного заказа.
 */
process.env.DATABASE_URL ??= 'postgresql://stub:stub@127.0.0.1:1/none';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapTeezOrder, mapTeezStatus } from '../src/integrations/teez.client';
import { mergeTeezOrders } from '../src/services/teezSync.service';

const base = {
  orderGuid: 'g-1',
  orderNumber: '1001',
  createdDate: '2026-10-01T10:00:00Z',
  statusKey: 'received',
  barcode: '2000000000011',
  productName: 'Кофемашина',
  quantity: 2,
  quantityReturned: 0,
  price: 5000,
  commissionAmount: 400,
};

describe('mapTeezStatus', () => {
  test('received → COMPLETED, pending → NEW, canceled → CANCELLED', () => {
    assert.equal(mapTeezStatus('received', 1), 'COMPLETED');
    assert.equal(mapTeezStatus('pending', 1), 'NEW');
    assert.equal(mapTeezStatus('canceled', 1), 'CANCELLED');
    assert.equal(mapTeezStatus(undefined, 1), 'NEW');
  });
  test('всё возвращено → RETURNED', () => {
    assert.equal(mapTeezStatus('received', 0), 'RETURNED');
  });
});

describe('mapTeezOrder', () => {
  test('выручка и комиссия считаются на количество', () => {
    const o = mapTeezOrder(base)!;
    assert.equal(o.marketplace, 'TEEZ');
    assert.equal(o.externalId, 'g-1');
    assert.equal(o.totalRevenue, 10000);
    assert.equal(o.marketplaceCommission, 800);
    assert.equal(o.items[0].quantity, 2);
    assert.equal(o.items[0].externalSku, '2000000000011');
  });
  test('частичный возврат уменьшает количество', () => {
    const o = mapTeezOrder({ ...base, quantityReturned: 1 })!;
    assert.equal(o.status, 'COMPLETED');
    assert.equal(o.items[0].quantity, 1);
    assert.equal(o.totalRevenue, 5000);
  });
  test('полный возврат → RETURNED, строка сохраняется', () => {
    const o = mapTeezOrder({ ...base, quantityReturned: 2 })!;
    assert.equal(o.status, 'RETURNED');
    assert.equal(o.items[0].quantity, 2);
  });
  test('без номера или даты строка пропускается', () => {
    assert.equal(mapTeezOrder({ ...base, orderGuid: '', orderNumber: '', orderId: undefined }), null);
    assert.equal(mapTeezOrder({ ...base, createdDate: undefined }), null);
  });
  test('цена берётся из totalPrice, если price нет', () => {
    const o = mapTeezOrder({ ...base, price: undefined, totalPrice: 9000, quantity: 3 })!;
    assert.equal(o.items[0].price, 3000);
  });
});

describe('mergeTeezOrders', () => {
  test('позиции одного заказа склеиваются, суммы складываются', () => {
    const a = mapTeezOrder(base)!;
    const b = mapTeezOrder({ ...base, barcode: '2000000000022', productName: 'Утюг', quantity: 1, price: 3000, commissionAmount: 300 })!;
    const merged = mergeTeezOrders([a, b]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].items.length, 2);
    assert.equal(merged[0].totalRevenue, 13000);
    assert.equal(merged[0].marketplaceCommission, 1100);
  });
  test('разные заказы остаются раздельными', () => {
    const a = mapTeezOrder(base)!;
    const b = mapTeezOrder({ ...base, orderGuid: 'g-2' })!;
    assert.equal(mergeTeezOrders([a, b]).length, 2);
  });
});
