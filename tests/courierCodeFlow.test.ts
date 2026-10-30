/**
 * Код выдачи: курьер запрашивает код → код уходит ТОЛЬКО покупателю (SMS + пуш), курьеру в ответе не возвращается;
 * заказ становится «доставлен» только по коду, который назвал покупатель.
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
process.env.SMS_API_KEY = 'test-sms-key';
process.env.SMS_PROVIDER = 'smsc';

type Row = Record<string, any>;
let courier: Row; let order: Row; let payouts: Row[] = [];
const BUYER = '77001112233';
const COURIER = '77005556677';
const stub: Row = {
  courier: {
    findUnique: async (a: Row) => (a.where.phone === courier.phone ? { ...courier } : null),
    update: async (a: Row) => { Object.assign(courier, a.data); return { ...courier }; },
  },
  shopOrder: {
    findUnique: async (a: Row) => (a.where.number === order.number ? { ...order } : null),
    update: async (a: Row) => { Object.assign(order, a.data); return { ...order }; },
  },
  shopCustomerPushToken: {
    findUnique: async (a: Row) => (a.where.phone === BUYER ? { phone: BUYER, token: 'ExponentPushToken[buyer]' } : null),
  },
  order: { updateMany: async () => ({ count: 1 }) },
  courierPayout: { create: async (a: Row) => { payouts.push(a.data); return a.data; } },
  $transaction: async (ops: any[]) => Promise.all(ops),
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

let expoCalls: Row[][] = [];
let smsCalls: Row[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).startsWith('https://exp.host/')) {
    const msgs: Row[] = JSON.parse(init.body);
    expoCalls.push(msgs);
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok', id: 'x' })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url) === 'https://smsc.kz/sys/send.php') {
    const p = new URLSearchParams(String(init.body));
    smsCalls.push({ phone: p.get('phones'), text: p.get('mes') });
    return new Response('OK - 1 SMS', { status: 200 });
  }
  return realFetch(url, init);
}) as typeof fetch;

interface Res { status: number; json: any }
let port = 0;
let server: http.Server;
function post(path: string, body: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'x-app-key': APP_KEY, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.write(payload); r.end();
  });
}

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  courier = { id: 'c1', phone: COURIER, active: true };
  order = { id: 'o1', number: 'MM-261030-0001', phone: BUYER, courierId: 'c1', status: 'in_transit', pickupCode: null, codeAttempts: 0, logisticsCost: 0 };
  payouts = []; expoCalls = []; smsCalls = [];
});

describe('код выдачи: курьер не видит код', () => {
  test('ответ курьеру без кода; код ушёл покупателю SMS и пушем (и только ему)', async () => {
    const r = await post('/api/shop/courier/request-code', { courierPhone: COURIER, orderNumber: order.number });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { ok: true });
    assert.ok(!JSON.stringify(r.json).includes(String(order.pickupCode)));
    assert.match(String(order.pickupCode), /^\d{5}$/);
    assert.equal(smsCalls.length, 1);
    assert.equal(smsCalls[0].phone, BUYER);
    assert.ok(String(smsCalls[0].text).includes(order.pickupCode));
    assert.equal(expoCalls[0][0].to, 'ExponentPushToken[buyer]');
    assert.equal(expoCalls[0][0].data.pickupCode, order.pickupCode);
  });

  test('заказ доставлен только по коду, который назвал покупатель; неверный код не закрывает', async () => {
    await post('/api/shop/courier/request-code', { courierPhone: COURIER, orderNumber: order.number });
    const code = String(order.pickupCode);
    const wrong = code === '11111' ? '22222' : '11111';
    const bad = await post('/api/shop/courier/deliver', { courierPhone: COURIER, orderNumber: order.number, code: wrong });
    assert.equal(bad.status, 400);
    assert.equal(order.status, 'in_transit');
    const ok = await post('/api/shop/courier/deliver', { courierPhone: COURIER, orderNumber: order.number, code });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(order.status, 'delivered');
    assert.equal(payouts.length, 1);
  });

  test('чужой курьер код запросить не может', async () => {
    order.courierId = 'другой';
    const r = await post('/api/shop/courier/request-code', { courierPhone: COURIER, orderNumber: order.number });
    assert.equal(r.status, 403);
    assert.equal(smsCalls.length + expoCalls.length, 0);
  });
});
