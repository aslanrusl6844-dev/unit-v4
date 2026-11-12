/**
 * Подписка «Вау»: расчёт скидки, подключение, заказ со скидкой, отмена/возврат. БД — заглушка в памяти.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const APP_KEY = randomBytes(8).toString('hex');
process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = APP_KEY;
process.env.ADMIN_USER = 'admin-test';
process.env.ADMIN_PASSWORD = randomBytes(12).toString('hex');

type Row = Record<string, any>;
let settings: Row | null = null;
let members: Row[] = [];
let orders: Row[] = [];
const products: Row[] = [
  { id: 'p1', sku: 'ozon-1', shopArticle: '1000001', name: 'Сушилка', shopPrice: 24990, shopCost: 12000, costPrice: 0, wowPercent: 5 },
  { id: 'p2', sku: 'ozon-2', shopArticle: '1000002', name: 'Чашка', shopPrice: 3000, shopCost: 2900, costPrice: 0, wowPercent: null },
];
let seq = 0;

const inList = (v: any, cond: any) => (cond && typeof cond === 'object' && 'in' in cond ? cond.in.includes(v) : v === cond);
function matchMember(m: Row, w: Row = {}) {
  if (w.phone && m.phone !== w.phone) return false;
  if (w.id && typeof w.id === 'string' && m.id !== w.id) return false;
  if (w.id && w.id.not && m.id === w.id.not) return false;
  if (w.status && !inList(m.status, w.status)) return false;
  if (w.endsAt?.gt && !(m.endsAt && m.endsAt > w.endsAt.gt)) return false;
  return true;
}
const stub: Row = {
  wowSettings: {
    findUnique: async () => settings,
    upsert: async (a: Row) => { settings = { ...(settings ?? { id: 'main', enabled: false, monthlyPrice: 2990, defaultPercent: 5, payInstructions: null }), ...(settings ? a.update : a.create) }; return settings; },
  },
  wowMembership: {
    findMany: async (a: Row) => members.filter((m) => matchMember(m, a.where)).sort((x, y) => y.createdAt - x.createdAt).map((m) => ({ ...m })),
    findFirst: async (a: Row) => members.filter((m) => matchMember(m, a.where))[0] ?? null,
    findUnique: async (a: Row) => members.find((m) => m.id === a.where.id) ?? null,
    create: async (a: Row) => { const m = { id: `m${++seq}`, createdAt: new Date(Date.now() + seq), cancelRequested: false, endsAt: null, startsAt: null, paidAt: null, cancelledAt: null, refundedAt: null, ...a.data }; members.push(m); return { ...m }; },
    update: async (a: Row) => { const m = members.find((x) => x.id === a.where.id)!; Object.assign(m, a.data); return { ...m }; },
  },
  product: {
    findMany: async (a: Row) => {
      const ors: Row[] = a.where?.OR ?? [];
      return products.filter((p) => !ors.length || ors.some((o) => Object.entries(o).every(([k, v]: any) => inList(p[k], v))))
        .filter((p) => !(a.where?.wowPercent?.not === null) || p.wowPercent != null);
    },
    findFirst: async () => null,
  },
  shopOrder: {
    findUnique: async () => null,
    create: async (a: Row) => { const o = { id: `o${++seq}`, createdAt: new Date(), status: 'pending_payment', ...a.data }; orders.push(o); return { ...o }; },
    findMany: async (a: Row) => orders.filter((o) => (!a.where?.membershipId || inList(o.membershipId, a.where.membershipId)) && (!a.where?.wowDiscount?.gt || o.wowDiscount > a.where.wowDiscount.gt) && o.status !== 'cancelled'),
  },
  shopCustomerPushToken: { findUnique: async () => null },
};
class StubPrismaClient {
  constructor() {
    return new Proxy(this, {
      get(_t, key) {
        if (key === 'then') return undefined;
        if (key in stub) return stub[key as string];
        return new Proxy({}, { get: () => async () => [] });
      },
    });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wow = require('../src/services/wow.service');

let port = 0;
let server: http.Server;
function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'x-app-key': APP_KEY, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const PHONE = '+7 700 555 00 11';
const order = (items: Row[]) => call('POST', '/api/shop/orders', { city: 'Алматы', street: 'Абая', house: '1', customerName: 'Аслан', phone: PHONE, items });

before(async () => { server = app.listen(0); port = (server.address() as any).port; });
after(() => server.close());
beforeEach(() => { settings = { id: 'main', enabled: true, monthlyPrice: 2990, defaultPercent: 5, payInstructions: 'Kaspi 8 700 000 00 00' }; members = []; orders = []; });

describe('расчёты', () => {
  test('цена со скидкой', () => {
    assert.equal(wow.wowPriceOf(24990, 5), 23741);
    assert.equal(wow.wowPriceOf(100000, 5), 95000);
    assert.equal(wow.wowPriceOf(1000, null), 1000);
  });
  test('месяц вперёд не перескакивает через февраль', () => {
    assert.equal(wow.addOneMonth(new Date('2026-01-31T10:00:00Z')).toISOString().slice(0, 10), '2026-02-28');
    assert.equal(wow.addOneMonth(new Date('2026-11-12T10:00:00Z')).toISOString().slice(0, 10), '2026-12-12');
  });
  test('процент 0 или вне 1..30 — метки нет', () => {
    assert.equal(wow.normalizeWowPercent(0), null);
    assert.equal(wow.normalizeWowPercent(45), null);
    assert.equal(wow.normalizeWowPercent('5'), 5);
  });
});

describe('подписка в приложении', () => {
  test('без подписки заказ без скидки', async () => {
    const r = await order([{ sku: '1000001', name: 'Сушилка', price: 24990, quantity: 1 }]);
    assert.equal(r.status, 201);
    assert.equal(r.json.wowDiscount, 0);
    assert.equal(r.json.total, 24990);
  });

  test('подключил → скидка только на товары «Вау», доставка по сумме до скидки', async () => {
    const s = await call('POST', '/api/shop/wow/subscribe', { phone: PHONE, name: 'Аслан' });
    assert.equal(s.status, 201);
    assert.equal(s.json.status, 'pending_payment');
    assert.equal(s.json.discountActive, true);
    // повторное нажатие не создаёт вторую подписку
    const s2 = await call('POST', '/api/shop/wow/subscribe', { phone: PHONE });
    assert.equal(s2.status, 200);
    assert.equal(members.length, 1);

    const r = await order([
      { sku: '1000001', name: 'Сушилка', price: 24990, quantity: 2 },
      { sku: '1000002', name: 'Чашка', price: 3000, quantity: 1 },
    ]);
    assert.equal(r.json.wowDiscount, 2498); // (24990 − 23741) × 2
    assert.equal(r.json.total, 24990 * 2 + 3000 - 2498);
    const saved = JSON.parse(orders[0].items);
    assert.equal(saved[0].price, 23741);
    assert.equal(saved[0].basePrice, 24990);
    assert.equal(saved[1].price, 3000);

    const st = await call('GET', `/api/shop/wow/status?phone=${encodeURIComponent(PHONE)}`);
    assert.equal(st.json.savedTotal, 2498);
    assert.equal(st.json.discountedOrders, 1);
  });

  test('подписка выключена в админке — скидки нет и подключить нельзя', async () => {
    settings!.enabled = false;
    const s = await call('POST', '/api/shop/wow/subscribe', { phone: PHONE });
    assert.equal(s.status, 409);
    const r = await order([{ sku: '1000001', name: 'Сушилка', price: 24990, quantity: 1 }]);
    assert.equal(r.json.wowDiscount, 0);
  });

  test('отмена без покупок со скидкой → возврат денег', async () => {
    await call('POST', '/api/shop/wow/subscribe', { phone: PHONE });
    members[0].status = 'active'; members[0].endsAt = new Date(Date.now() + 86400_000 * 20);
    const c = await call('POST', '/api/shop/wow/cancel', { phone: PHONE });
    assert.equal(c.json.result, 'refund_requested');
    const r = await order([{ sku: '1000001', name: 'Сушилка', price: 24990, quantity: 1 }]);
    assert.equal(r.json.wowDiscount, 0); // скидка выключилась сразу
  });

  test('отмена после покупки со скидкой → без возврата, работает до конца месяца', async () => {
    await call('POST', '/api/shop/wow/subscribe', { phone: PHONE });
    members[0].status = 'active'; members[0].endsAt = new Date(Date.now() + 86400_000 * 20);
    await order([{ sku: '1000001', name: 'Сушилка', price: 24990, quantity: 1 }]);
    const c = await call('POST', '/api/shop/wow/cancel', { phone: PHONE });
    assert.equal(c.json.result, 'no_renew');
    assert.equal(c.json.willRenew, false);
    const r = await order([{ sku: '1000001', name: 'Сушилка', price: 24990, quantity: 1 }]);
    assert.ok(r.json.wowDiscount > 0);
  });

  test('закончившаяся подписка скидку не даёт', async () => {
    await call('POST', '/api/shop/wow/subscribe', { phone: PHONE });
    members[0].status = 'active'; members[0].endsAt = new Date(Date.now() - 1000);
    const r = await order([{ sku: '1000001', name: 'Сушилка', price: 24990, quantity: 1 }]);
    assert.equal(r.json.wowDiscount, 0);
  });

  test('срок скидки на товаре прошёл — кнопки «Вау» нет и скидки нет', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { toShopProduct } = require('../src/routes/shop.routes');
    products[0].wowUntil = new Date(Date.now() - 1000);
    try {
      const p = toShopProduct({ ...products[0], images: null, characteristics: null });
      assert.equal(p.wowPrice, null);
      await call('POST', '/api/shop/wow/subscribe', { phone: PHONE });
      const r = await order([{ sku: '1000001', name: 'Сушилка', price: 24990, quantity: 1 }]);
      assert.equal(r.json.wowDiscount, 0);
    } finally {
      products[0].wowUntil = null;
    }
  });

  test('товар отдаёт цену «Вау»', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { toShopProduct } = require('../src/routes/shop.routes');
    const p = toShopProduct({ ...products[0], images: null, characteristics: null });
    assert.equal(p.wowPercent, 5);
    assert.equal(p.wowPrice, 23741);
    assert.equal(toShopProduct({ ...products[1], images: null, characteristics: null }).wowPrice, null);
  });
});
