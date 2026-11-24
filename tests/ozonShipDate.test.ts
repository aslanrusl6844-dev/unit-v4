import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ozonShipDate } from '../src/routes/ozonFbo.routes';

test('ozonShipDate: берёт delivering_date из данных Ozon', () => {
  const d = ozonShipDate({ orderDate: new Date('2026-11-22T10:00:00Z'), rawData: JSON.stringify({ delivering_date: '2026-11-24T11:24:59Z' }) });
  assert.equal(d.toISOString(), '2026-11-24T11:24:59.000Z');
});

test('ozonShipDate: без delivering_date — дата заказа', () => {
  const od = new Date('2026-11-22T10:00:00Z');
  assert.equal(ozonShipDate({ orderDate: od, rawData: '{"status":"delivering"}' }).toISOString(), od.toISOString());
  assert.equal(ozonShipDate({ orderDate: od, rawData: 'не json' }).toISOString(), od.toISOString());
  assert.equal(ozonShipDate({ orderDate: od }).toISOString(), od.toISOString());
});
