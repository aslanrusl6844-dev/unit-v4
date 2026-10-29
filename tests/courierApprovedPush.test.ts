/**
 * «Одобрить» заявку курьера (POST /api/shop-admin/courier-applications/:id/approve): курьеру на телефон заявки
 * уходит пуш «Ваша заявка на курьера одобрена…» — токен из ShopCustomerPushToken. Нет токена / сбой пуша —
 * заявка всё равно одобрена. Повторное «Одобрить» пуш не дублирует. БД и Expo — заглушки.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = randomBytes(8).toString('hex');
process.env.ADMIN_USER = 'admin-test';
process.env.ADMIN_PASSWORD = randomBytes(12).toString('hex');

type Row = Record<string, any>;
let apps: Row[] = [];
let tokens: Row[] = [];
const stub: Row = {
  shopCourierApplication: {
    findUnique: async (a: Row) => { const x = apps.find((r) => r.id === a.where.id); return x ? { ...x } : null; },
    update: async (a: Row) => {
      const x = apps.find((r) => r.id === a.where.id);
      if (!x) throw Object.assign(new Error('nf'), { code: 'P2025' });
      Object.assign(x, a.data);
      return { ...x };
    },
  },
  shopCustomerPushToken: {
    findUnique: async (a: Row) => { const r = tokens.find((x) => x.phone === a.where.phone); return r ? { ...r } : null; },
  },
};
class StubPrismaClient {
  constructor() {
    return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; if (key in stub) return stub[key as string]; return new Proxy({}, { get: () => async () => [] }); } });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;

let expoCalls: Row[][] = [];
let expoDown = false;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).startsWith('https://exp.host/')) {
    if (expoDown) throw new Error('network down');
    const msgs: Row[] = JSON.parse(init.body);
    expoCalls.push(msgs);
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok', id: 'x' })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('unexpected fetch ' + String(url));
}) as any;

let port = 0;
let server: http.Server;
const AUTH = { authorization: 'Basic ' + Buffer.from(`admin-test:${process.env.ADMIN_PASSWORD}`).toString('base64'), 'sec-fetch-site': 'same-origin' };
function post(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: AUTH }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* не JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}
before(async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port; });
after(() => new Promise<void>((r) => server.close(() => r())));

const application = (o: Row = {}): Row => ({ id: 'a1', phone: '77011112233', name: 'Али Ким', city: 'Алматы', iin: '900101300123', status: 'pending', archived: false, createdAt: new Date('2026-10-01'), reviewedAt: null, ...o });
beforeEach(() => { apps = []; tokens = []; expoCalls = []; expoDown = false; });

const TEXT = 'Ваша заявка на курьера одобрена. Откройте «Я курьер» и заполните данные.';

describe('«Одобрить» → пуш курьеру', () => {
  test('есть токен по телефону заявки → пуш с нужным текстом именно на этот токен', async () => {
    apps = [application()];
    tokens = [{ phone: '77011112233', token: 'ExponentPushToken[courier]' }, { phone: '77019999999', token: 'ExponentPushToken[other]' }];
    const r = await post('/api/shop-admin/courier-applications/a1/approve');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'approved');
    assert.equal(expoCalls.length, 1);
    assert.equal(expoCalls[0].length, 1);
    assert.equal(expoCalls[0][0].to, 'ExponentPushToken[courier]');
    assert.equal(expoCalls[0][0].body, TEXT);
  });

  test('токена нет → заявка одобрена, пуша нет', async () => {
    apps = [application()];
    const r = await post('/api/shop-admin/courier-applications/a1/approve');
    assert.equal(r.status, 200);
    assert.equal(apps[0].status, 'approved');
    assert.equal(expoCalls.length, 0);
  });

  test('пуш упал (сеть) → заявка всё равно одобрена, ответ 200', async () => {
    apps = [application()];
    tokens = [{ phone: '77011112233', token: 'ExponentPushToken[courier]' }];
    expoDown = true;
    const r = await post('/api/shop-admin/courier-applications/a1/approve');
    assert.equal(r.status, 200);
    assert.equal(apps[0].status, 'approved');
  });

  test('повторное «Одобрить» уже одобренной не дублирует пуш; несуществующая заявка — 404', async () => {
    apps = [application({ status: 'approved' })];
    tokens = [{ phone: '77011112233', token: 'ExponentPushToken[courier]' }];
    assert.equal((await post('/api/shop-admin/courier-applications/a1/approve')).status, 200);
    assert.equal(expoCalls.length, 0);
    assert.equal((await post('/api/shop-admin/courier-applications/nope/approve')).status, 404);
  });

  test('«Отказать» пуш не шлёт', async () => {
    apps = [application()];
    tokens = [{ phone: '77011112233', token: 'ExponentPushToken[courier]' }];
    const r = await post('/api/shop-admin/courier-applications/a1/reject');
    assert.equal(r.status, 200);
    assert.equal(expoCalls.length, 0);
  });
});
