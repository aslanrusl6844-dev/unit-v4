/**
 * Озон → «Доставленные»: выкупленные FBS (из нашей базы, реальные комиссии) и FBO (из Ozon, комиссия по тарифу товара),
 * чистая прибыль = выручка − себестоимость − комиссии и логистика − налог. БД и Ozon — заглушки.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
type Row = Record<string, any>;
const orders: Row[] = [
  { externalId: 'FBS-1', status: 'delivered', orderDate: new Date('2026-11-10T08:00:00Z'), totalRevenue: 10000, marketplaceCommission: 1500, logisticsCost: 500, acquiringCost: 0, otherFees: 0,
    items: [{ name: 'Чайник', externalSku: 'A', quantity: 2, price: 5000, costPrice: 2000 }] },
];
const stub: Record<string, any> = {
  order: { findMany: async (a: Row) => orders.filter((o) => o.status === a.where.status) },
  product: { findMany: async () => [{ sku: 'B', ozonOfferId: 'B', costPrice: 1000, packagingCost: 0, ozonCommissionRatePct: 10, ozonLogisticsAmount: 300, ozonLastMileAmount: 0, ozonAcquiringAmount: 0 }] },
  taxSettings: { findFirst: async () => ({ ratePct: 4 }) },
};
class StubPrismaClient {
  constructor() { return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; return stub[key as string] ?? new Proxy({}, { get: () => async () => [] }); } }); }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ozonClient } = require('../src/integrations/ozon.client');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ozonFboRouter } = require('../src/routes/ozonFbo.routes');

test('доставленные FBS + FBO с чистой прибылью; отменённые FBO не попадают', async () => {
  ozonClient.fetchFboPostings = async () => [
    { postingNumber: 'FBO-1', status: 'delivered', createdAt: '2026-11-12T10:00:00Z', offerId: 'B', name: 'Кружка', quantity: 1, price: 5000 },
    { postingNumber: 'FBO-2', status: 'cancelled', createdAt: '2026-11-12T10:00:00Z', offerId: 'B', name: 'Кружка', quantity: 1, price: 5000 },
  ];
  const app = express();
  app.use('/api/ozon-fbo', ozonFboRouter);
  const srv = app.listen(0);
  const port = (srv.address() as AddressInfo).port;
  const r = await (await fetch(`http://127.0.0.1:${port}/api/ozon-fbo/delivered?from=2026-11-01&to=2026-11-20`)).json();
  srv.close();
  const fbs = r.rows.find((x: Row) => x.scheme === 'FBS');
  const fbo = r.rows.find((x: Row) => x.scheme === 'FBO');
  // FBS: 10 000 − 4 000 − 2 000 − 400 налог = 3 600
  assert.deepEqual([fbs.revenue, fbs.cogs, fbs.fees, fbs.tax, fbs.profit], [10000, 4000, 2000, 400, 3600]);
  // FBO: 5 000 − 1 000 − (500 + 300) − 200 = 3 000
  assert.deepEqual([fbo.revenue, fbo.cogs, fbo.fees, fbo.tax, fbo.profit, fbo.estimated], [5000, 1000, 800, 200, 3000, true]);
  assert.equal(r.rows.length, 2);
  assert.deepEqual([r.totals.all.orders, r.totals.all.profit], [2, 6600]);
});
