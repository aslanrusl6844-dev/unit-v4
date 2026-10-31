process.env.DATABASE_URL ??= 'postgresql://stub:stub@127.0.0.1:1/none';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeo, type GeoOrderRow } from '../src/services/shopGeo.service';

const d = (s: string) => new Date(s);
function order(p: Partial<GeoOrderRow>): GeoOrderRow {
  return {
    city: 'Кокшетау', status: 'paid', total: 1000, items: JSON.stringify([{ sku: 'a', name: 'Молоко', price: 500, quantity: 2 }]),
    createdAt: d('2026-10-01T10:00:00Z'), updatedAt: d('2026-10-01T10:00:00Z'), deliveredAt: null, ...p,
  };
}

test('заказы считаются по городам, неоплаченные и отменённые не в счёт', () => {
  const g = buildGeo([
    order({}), order({ status: 'delivered', deliveredAt: d('2026-10-05T10:00:00Z') }),
    order({ status: 'pending_payment' }), order({ status: 'cancelled' }),
    order({ city: 'нур-султан' }), order({ city: 'Неизвестноград' }),
  ], []);
  const kok = g.cities.find((c) => c.city === 'Кокшетау')!;
  assert.equal(kok.orders, 2);
  assert.equal(kok.paid, 1);
  assert.equal(kok.delivered, 1);
  assert.equal(kok.revenue, 2000);
  assert.deepEqual(kok.topItems, [{ name: 'Молоко', qty: 4 }]);
  assert.equal(g.cities.find((c) => c.city === 'Астана')!.orders, 1);
  assert.equal(g.otherOrders, 1);
  assert.equal(g.cities.length, 20);
});

test('«в пути»: считаем заказы и берём самое раннее время', () => {
  const g = buildGeo([
    order({ status: 'in_transit', updatedAt: d('2026-10-03T00:00:00Z') }),
    order({ status: 'picked', updatedAt: d('2026-10-02T00:00:00Z') }),
  ], []);
  const kok = g.cities.find((c) => c.city === 'Кокшетау')!;
  assert.equal(kok.inTransit, 2);
  assert.equal(kok.transitSince, '2026-10-02T00:00:00.000Z');
});

test('поисковые запросы по городам, регистр не важен', () => {
  const g = buildGeo([], [
    { id: '1', city: 'Алматы', query: 'Молоко', phone: null },
    { id: '2', city: 'алматы', query: 'молоко ', phone: null },
    { id: '3', city: 'Алматы', query: 'хлеб', phone: null },
    { id: '4', city: null, query: 'хлеб', phone: null },
  ]);
  const alm = g.cities.find((c) => c.city === 'Алматы')!;
  assert.equal(alm.searches, 3);
  assert.deepEqual(alm.topQueries[0], { query: 'молоко', count: 2 });
  assert.equal(g.otherSearches, 1);
});

test('кривой JSON в items не ломает расчёт', () => {
  const g = buildGeo([order({ items: 'не json' })], []);
  assert.equal(g.cities.find((c) => c.city === 'Кокшетау')!.orders, 1);
});
