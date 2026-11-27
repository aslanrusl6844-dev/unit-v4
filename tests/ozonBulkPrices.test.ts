import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBulkOzonPrices } from '../src/routes/sync.routes';

const cur = (price: number | null, oldPrice: number | null = null, minPrice: number | null = null) => ({ price, oldPrice, minPrice, currency: 'KZT' });

test('массовые цены: одинаковая цена и зачёркнутая всем', () => {
  const r = planBulkOzonPrices(
    [{ id: 'a', name: 'A', offerId: '1', cur: cur(1700, 2000) }, { id: 'b', name: 'B', offerId: '2', cur: cur(1500) }],
    { price: 1600, oldPrice: 2500, minPrice: null },
  );
  assert.equal(r.skipped.length, 0);
  assert.deepEqual(r.send.map((x) => [x.offerId, x.price, x.oldPrice, x.minPrice]), [['1', 1600, 2500, undefined], ['2', 1600, 2500, undefined]]);
});

test('массовые цены: пустое поле — у каждого своё текущее', () => {
  const r = planBulkOzonPrices([{ id: 'a', name: 'A', offerId: '1', cur: cur(1700, 2000) }], { price: null, oldPrice: null, minPrice: 1200 });
  assert.deepEqual(r.send.map((x) => [x.price, x.oldPrice, x.minPrice]), [[1700, 2000, 1200]]);
});

test('массовые цены: неподходящие товары пропускаются с причиной', () => {
  const r = planBulkOzonPrices(
    [
      { id: 'a', name: 'A', offerId: '1', cur: cur(3000) },
      { id: 'b', name: 'B', offerId: '2', cur: null },
      { id: 'c', name: 'C', offerId: '3', cur: cur(1000) },
    ],
    { price: null, oldPrice: 2500, minPrice: null },
  );
  assert.deepEqual(r.send.map((x) => x.id), ['c']);
  assert.deepEqual(r.skipped.map((x) => x.id), ['a', 'b']);
});

test('массовые цены: oldPrice = 0 убирает зачёркнутую', () => {
  const r = planBulkOzonPrices([{ id: 'a', name: 'A', offerId: '1', cur: cur(1700, 2000) }], { price: null, oldPrice: 0, minPrice: null });
  assert.equal(r.send[0].oldPrice, 0);
});
