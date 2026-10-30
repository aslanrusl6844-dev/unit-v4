/**
 * Тесты накладной «Двора»: адрес заказа (улица, подъезд, этаж, квартира, домофон), расстояние
 * от магазина, кнопка продавца «Оплачено» (/yard/orders/:id/paid) и список заказов продавца.
 * База не используется: @prisma/client подменяется заглушкой в памяти.
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
let seq = 0;
const newId = () => `f${++seq}`;
const tables: { shop: Row[]; item: Row[]; order: Row[]; shopMsg: Row[] } = { shop: [], item: [], order: [], shopMsg: [] };

function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
}
const withRelations = (o: Row, include?: Row) => {
  const out: Row = { ...o };
  if (include?.shop) out.shop = { ...tables.shop.find((s) => s.id === o.shopId) };
  if (!include?.items) delete out.items;
  return out;
};
const yardItem = {
  findMany: async (a: Row = {}) => tables.item.filter((r) => match(r, a.where)).map((r) => ({ ...r })),
  findUnique: async (a: Row) => { const r = tables.item.find((x) => match(x, a.where)); return r ? { ...r } : null; },
  update: async (a: Row) => {
    const r = tables.item.find((x) => match(x, a.where))!;
    if (a.data.stock?.decrement) r.stock -= a.data.stock.decrement; else Object.assign(r, a.data);
    return { ...r };
  },
};
const yardOrder = {
  findUnique: async (a: Row) => {
    const r = tables.order.find((x) => match(x, a.where));
    return r ? withRelations(r, a.include) : null;
  },
  findMany: async (a: Row = {}) => tables.order.filter((r) => match(r, a.where)).map((r) => withRelations(r, a.include)),
  create: async (a: Row) => {
    const { items, ...rest } = a.data;
    const row = { id: newId(), createdAt: new Date(), ...rest, items: (items?.create ?? []).map((i: Row) => ({ id: newId(), ...i })) };
    tables.order.push(row);
    return { ...row };
  },
  update: async (a: Row) => {
    const r = tables.order.find((x) => match(x, a.where))!;
    Object.assign(r, a.data);
    return withRelations(r, a.include);
  },
};
const stub: Row = {
  yardShop: {
    findMany: async (a: Row = {}) => tables.shop.filter((r) => match(r, a.where)).map((r) => ({ ...r })),
    findUnique: async (a: Row) => { const r = tables.shop.find((x) => match(x, a.where)); return r ? { ...r } : null; },
  },
  yardItem,
  yardOrder,
  yardShopMessage: {
    create: async (a: Row) => { const row = { id: newId(), createdAt: new Date(), ...a.data }; tables.shopMsg.push(row); return row; },
    findMany: async () => [],
  },
  $transaction: async (fn: (tx: Row) => Promise<any>) => fn({ yardItem, yardOrder }),
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
const { yardOrderDistance, yardAppStatus, yardDistanceMeters } = require('../src/services/yard.service');

interface Res { status: number; json: any }
let port = 0;
let server: http.Server;
function call(method: string, path: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h: Record<string, string> = { 'x-app-key': APP_KEY };
    if (payload !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = String(Buffer.byteLength(payload)); }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* не JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

const SELLER = '77001112233';
const BUYER = '77075556677';
const SHOP_LAT = 43.2;
const SHOP_LNG = 76.9;
function at(meters: number) {
  let lat = SHOP_LAT + meters / 111195;
  for (let i = 0; i < 5; i++) lat += (meters - yardDistanceMeters(lat, SHOP_LNG, SHOP_LAT, SHOP_LNG)) / 111195;
  return { lat, lng: SHOP_LNG };
}
function seed() {
  const shop = { id: newId(), phone: SELLER, name: 'Двор Аслана', lat: SHOP_LAT, lng: SHOP_LNG, active: true, paidUntil: new Date(Date.now() + 86400_000), archived: false, radiusMeters: 500 };
  tables.shop.push(shop);
  const item = { id: newId(), shopId: shop.id, name: 'Хлеб', price: 200, stock: 10, active: true, archived: false };
  tables.item.push(item);
  return { shop, item };
}
async function createOrder(shopId: string, itemId: string, extra: Row = {}) {
  const p = at(250);
  const r = await call('POST', '/api/shop/yard/orders', {
    shopId, lat: p.lat, lng: p.lng, buyerPhone: BUYER, buyerName: 'Мария', items: [{ itemId, qty: 2 }], ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id as string;
}

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { tables.shop = []; tables.item = []; tables.order = []; tables.shopMsg = []; });

describe('хелперы накладной', () => {
  test('yardAppStatus: статусы сервера → статусы приложения', () => {
    assert.equal(yardAppStatus('waiting_payment'), 'waiting_payment');
    assert.equal(yardAppStatus('paid'), 'paid');
    for (const s of ['accepted', 'at_door', 'done']) assert.equal(yardAppStatus(s), 'accepted');
    for (const s of ['no_payment', 'not_picked', 'out_of_stock']) assert.equal(yardAppStatus(s), 'rejected');
  });
  test('yardOrderDistance: метры от магазина, null без координат', () => {
    const p = at(300);
    assert.equal(yardOrderDistance(p, { lat: SHOP_LAT, lng: SHOP_LNG }), 300);
    assert.equal(yardOrderDistance({ lat: 0, lng: 0 }, { lat: SHOP_LAT, lng: SHOP_LNG }), null);
    assert.equal(yardOrderDistance({}, { lat: SHOP_LAT, lng: SHOP_LNG }), null);
  });
});

describe('адрес заказа', () => {
  test('адрес можно прислать сразу в POST /yard/orders', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id, { address: ' ул. Абая 1 ', entrance: '2', floor: '5', apartment: '37', intercom: '37К' });
    const row = tables.order.find((o) => o.id === id)!;
    assert.deepEqual([row.address, row.entrance, row.floor, row.apartment, row.intercom], ['ул. Абая 1', '2', '5', '37', '37К']);
  });

  test('POST /yard/order-address: покупатель дописывает адрес; чужой — 403; пустая строка очищает', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id);
    const bad = await call('POST', '/api/shop/yard/order-address', { orderId: id, phone: '77000000000', address: 'x' });
    assert.equal(bad.status, 403);
    const ok = await call('POST', '/api/shop/yard/order-address', { orderId: id, phone: BUYER, address: 'ул. Абая 1', entrance: '2', floor: '5', apartment: '37', intercom: '37К' });
    assert.equal(ok.status, 200);
    const row = tables.order.find((o) => o.id === id)!;
    assert.equal(row.intercom, '37К');
    await call('POST', '/api/shop/yard/order-address', { orderId: id, phone: BUYER, intercom: '' });
    assert.equal(row.intercom, null);
    assert.equal(row.address, 'ул. Абая 1');
    assert.equal((await call('POST', '/api/shop/yard/order-address', { orderId: id, phone: BUYER })).status, 400);
  });

  test('закрытому заказу адрес не добавить; несуществующему — 404', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id);
    tables.order[0].status = 'done';
    assert.equal((await call('POST', '/api/shop/yard/order-address', { orderId: id, phone: BUYER, address: 'x' })).status, 409);
    assert.equal((await call('POST', '/api/shop/yard/order-address', { orderId: 'nope', phone: BUYER, address: 'x' })).status, 404);
  });
});

describe('создание заказа не должно молча срываться', () => {
  test('пустое имя покупателя: заказ создаётся, имя — «Покупатель»', async () => {
    const { shop, item } = seed();
    const p = at(250);
    const r = await call('POST', '/api/shop/yard/orders', { shopId: shop.id, lat: p.lat, lng: p.lng, buyerPhone: BUYER, buyerName: '', items: [{ itemId: item.id, qty: 1 }] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(tables.order[0].buyerName, 'Покупатель');
  });
  test('нет имени вовсе: тоже создаётся', async () => {
    const { shop, item } = seed();
    const p = at(250);
    const r = await call('POST', '/api/shop/yard/orders', { shopId: shop.id, lat: p.lat, lng: p.lng, buyerPhone: BUYER, items: [{ itemId: item.id, qty: 1 }] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  });
  test('точка 0,0 (местоположение неизвестно): заказ создаётся, координаты не пишутся, расстояния нет', async () => {
    const { shop, item } = seed();
    const r = await call('POST', '/api/shop/yard/orders', { shopId: shop.id, lat: 0, lng: 0, buyerPhone: BUYER, buyerName: 'Мария', items: [{ itemId: item.id, qty: 1 }] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(tables.order[0].lat, null);
    await call('POST', `/api/shop/yard/orders/${tables.order[0].id}/paid`, { phone: SELLER });
    const o = (await call('GET', `/api/shop/yard/mine?phone=${SELLER}`)).json.orders[0];
    assert.equal(o.distanceMeters, null);
  });
  test('настоящая точка вне радиуса магазина по-прежнему отклоняется (403)', async () => {
    const { shop, item } = seed();
    const p = at(900);
    const r = await call('POST', '/api/shop/yard/orders', { shopId: shop.id, lat: p.lat, lng: p.lng, buyerPhone: BUYER, buyerName: 'М', items: [{ itemId: item.id, qty: 1 }] });
    assert.equal(r.status, 403);
    assert.equal(tables.order.length, 0);
  });
  test('сумма и состав считает сервер по корзине: цена с полки, количество из запроса; клиентская цена игнорируется', async () => {
    const { shop, item } = seed();
    const item2 = { id: newId(), shopId: shop.id, name: 'Молоко', price: 450, stock: 5, active: true, archived: false };
    tables.item.push(item2);
    const p = at(100);
    const r = await call('POST', '/api/shop/yard/orders', { shopId: shop.id, lat: p.lat, lng: p.lng, buyerPhone: BUYER, buyerName: 'М', items: [{ itemId: item.id, qty: 3, price: 1 }, { itemId: item2.id, qty: 2 }] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const row = tables.order[0];
    assert.equal(row.total, 3 * 200 + 2 * 450);
    assert.deepEqual(row.items.map((i: Row) => [i.name, i.qty]), [['Хлеб', 3], ['Молоко', 2]]);
    await call('POST', `/api/shop/yard/orders/${row.id}/paid`, { phone: SELLER });
    assert.deepEqual([tables.item[0].stock, tables.item[1].stock], [7, 3]); // списаны именно товары корзины
  });
});

describe('«Оплачено» и накладная продавца', () => {
  test('до оплаты адрес и расстояние продавцу не отдаются, номер и имя — да', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id, { address: 'ул. Абая 1', apartment: '37' });
    const mine = await call('GET', `/api/shop/yard/mine?phone=${SELLER}`);
    const o = mine.json.orders.find((x: Row) => x.id === id);
    assert.equal(o.buyerPhone, BUYER);
    assert.equal(o.buyerName, 'Мария');
    assert.equal(o.address, null);
    assert.equal(o.apartment, null);
    assert.equal(o.distanceMeters, null);
    assert.equal(o.shopRadiusMeters, 500);
  });

  test('POST /paid: только продавец; заказ → paid, полка списана, покупателю «✅ Оплачено» в чат', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id);
    assert.equal((await call('POST', `/api/shop/yard/orders/${id}/paid`, { phone: BUYER })).status, 403);
    assert.equal(tables.order[0].status, 'waiting_payment');
    const r = await call('POST', `/api/shop/yard/orders/${id}/paid`, { phone: SELLER });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(tables.order[0].status, 'paid');
    assert.ok(tables.order[0].paidAt instanceof Date, 'время подтверждения оплаты записано (по нему приложение держит «Оплачено» 30 минут)');
    assert.ok(Math.abs(Date.now() - tables.order[0].paidAt.getTime()) < 5000);
    assert.equal(tables.item[0].stock, 8);
    assert.equal(tables.shopMsg.length, 1);
    assert.equal(tables.shopMsg[0].text, '✅ Оплачено');
    assert.equal(tables.shopMsg[0].from, 'shop');
    assert.equal(tables.shopMsg[0].buyerPhone, BUYER);
  });

  test('повторное «Оплачено» — не ошибка, полка и чат не дублируются', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id);
    await call('POST', `/api/shop/yard/orders/${id}/paid`, { phone: SELLER });
    const again = await call('POST', `/api/shop/yard/orders/${id}/paid`, { phone: SELLER });
    assert.equal(again.status, 200);
    assert.equal(tables.item[0].stock, 8);
    assert.equal(tables.shopMsg.length, 1);
  });

  test('после «Оплачено» /yard/mine отдаёт накладную: адрес, подъезд, этаж, квартира, домофон, расстояние, радиус', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id, { address: 'ул. Абая 1', entrance: '2', floor: '5', apartment: '37', intercom: '37К' });
    await call('POST', `/api/shop/yard/orders/${id}/paid`, { phone: SELLER });
    const mine = await call('GET', `/api/shop/yard/mine?phone=${SELLER}`);
    const o = mine.json.orders.find((x: Row) => x.id === id);
    assert.equal(o.status, 'paid');
    assert.deepEqual([o.buyerName, o.buyerPhone, o.address, o.entrance, o.floor, o.apartment, o.intercom], ['Мария', BUYER, 'ул. Абая 1', '2', '5', '37', '37К']);
    assert.equal(o.distanceMeters, 250);
    assert.equal(o.shopRadiusMeters, 500);
  });

  test('POST /reject: «оплаты нет» гасит заказ без списания; повтор — не ошибка', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id);
    assert.equal((await call('POST', `/api/shop/yard/orders/${id}/reject`, { phone: SELLER })).status, 200);
    assert.equal(tables.order[0].status, 'no_payment');
    assert.equal(tables.item[0].stock, 10);
    assert.equal((await call('POST', `/api/shop/yard/orders/${id}/reject`, { phone: SELLER })).status, 200);
  });

  test('«Оплачено» у отклонённого заказа — 409, а не молчаливый успех', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id);
    await call('POST', `/api/shop/yard/orders/${id}/reject`, { phone: SELLER });
    assert.equal((await call('POST', `/api/shop/yard/orders/${id}/paid`, { phone: SELLER })).status, 409);
  });
});

describe('GET /yard/orders/:id', () => {
  test('участвуют только покупатель и продавец; продавец видит накладную, покупатель — статус для экрана', async () => {
    const { shop, item } = seed();
    const id = await createOrder(shop.id, item.id, { address: 'ул. Абая 1', intercom: '37К' });
    assert.equal((await call('GET', `/api/shop/yard/orders/${id}?phone=77000000000`)).status, 403);
    assert.equal((await call('GET', `/api/shop/yard/orders/nope?phone=${BUYER}`)).status, 404);
    const before = await call('GET', `/api/shop/yard/orders/${id}?phone=${SELLER}`);
    assert.equal(before.json.status, 'waiting_payment');
    assert.equal(before.json.address, null);
    await call('POST', `/api/shop/yard/orders/${id}/paid`, { phone: SELLER });
    const seller = await call('GET', `/api/shop/yard/orders/${id}?phone=${SELLER}`);
    assert.equal(seller.json.status, 'paid');
    assert.equal(seller.json.address, 'ул. Абая 1');
    assert.equal(seller.json.intercom, '37К');
    assert.equal(seller.json.distanceMeters, 250);
    assert.equal(seller.json.shop.phone, SELLER);
    const buyer = await call('GET', `/api/shop/yard/orders/${id}?phone=${BUYER}`);
    assert.equal(buyer.json.status, 'paid');
    assert.equal(buyer.json.shop.phone, null); // телефон магазина — только с «Принял»
    assert.equal(buyer.json.address, 'ул. Абая 1');
  });
});
