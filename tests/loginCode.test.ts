/**
 * Код входа покупателя: сервер создаёт код и шлёт пушем только на устройство, где номер уже входил.
 * БД и Expo — заглушки.
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
let devices: Row[] = [];
let codes: Row[] = [];
const stub: Row = {
  shopCustomerPushToken: {
    findUnique: async (a: Row) => { const r = devices.find((x) => x.phone === a.where.phone); return r ? { ...r } : null; },
  },
  shopLoginCode: {
    findUnique: async (a: Row) => { const r = codes.find((x) => x.phone === a.where.phone); return r ? { ...r } : null; },
    upsert: async (a: Row) => {
      const r = codes.find((x) => x.phone === a.where.phone);
      if (r) { Object.assign(r, a.update); return { ...r }; }
      codes.push({ ...a.create }); return { ...a.create };
    },
    update: async (a: Row) => { const r = codes.find((x) => x.phone === a.where.phone)!; Object.assign(r, a.data); return { ...r }; },
    deleteMany: async (a: Row) => { codes = codes.filter((x) => x.phone !== a.where.phone); return { count: 1 }; },
  },
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
let expoOk = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).startsWith('https://exp.host/')) {
    const msgs: Row[] = JSON.parse(init.body);
    expoCalls.push(msgs);
    const data = msgs.map(() => (expoOk ? { status: 'ok', id: 'x' } : { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }));
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
}) as typeof fetch;

interface Res { status: number; json: any }
let port = 0;
let server: http.Server;
function call(path: string, body: unknown): Promise<Res> {
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
const sentCode = () => String(expoCalls[0][0].data.code);

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { devices = [{ phone: '77001112233', token: 'ExponentPushToken[known]' }]; codes = []; expoCalls = []; expoOk = true; });

describe('POST /auth/request-code', () => {
  test('известный номер: код уходит пушем на его устройство, в ответе кода нет', async () => {
    const r = await call('/api/shop/auth/request-code', { phone: '+7 700 111 22 33' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(expoCalls.length, 1);
    assert.equal(expoCalls[0][0].to, 'ExponentPushToken[known]');
    assert.match(String(expoCalls[0][0].data.code), /^\d{4}$/);
    assert.match(expoCalls[0][0].body, /Код входа: \d{4}/);
    assert.ok(!JSON.stringify(r.json).includes(sentCode()), 'код нельзя возвращать в ответе');
    assert.ok(!codes[0].codeHash.includes(sentCode()), 'в базе только хэш');
  });

  test('выдуманный (неизвестный) номер: 404, пуш никому не уходит', async () => {
    const r = await call('/api/shop/auth/request-code', { phone: '+77009998877' });
    assert.equal(r.status, 404);
    assert.equal(r.json.reason, 'unknown_number');
    assert.equal(expoCalls.length, 0);
    assert.equal(codes.length, 0);
  });

  test('некорректный номер: 400', async () => {
    const r = await call('/api/shop/auth/request-code', { phone: '123' });
    assert.equal(r.status, 400);
    assert.equal(expoCalls.length, 0);
  });

  test('повтор раньше чем через 30 секунд: 429, второй пуш не уходит', async () => {
    await call('/api/shop/auth/request-code', { phone: '+77001112233' });
    const r = await call('/api/shop/auth/request-code', { phone: '+77001112233' });
    assert.equal(r.status, 429);
    assert.equal(expoCalls.length, 1);
  });

  test('устройство не приняло пуш: 502, код не остаётся в базе', async () => {
    expoOk = false;
    const r = await call('/api/shop/auth/request-code', { phone: '+77001112233' });
    assert.equal(r.status, 502);
    assert.equal(r.json.reason, 'push_failed');
    assert.equal(codes.length, 0);
  });

  test('без x-app-key нельзя', async () => {
    const payload = JSON.stringify({ phone: '+77001112233' });
    const status = await new Promise<number>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/shop/auth/request-code', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.write(payload); r.end();
    });
    assert.equal(status, 401);
  });
});

describe('POST /auth/verify-code', () => {
  test('верный код проходит один раз и сгорает', async () => {
    await call('/api/shop/auth/request-code', { phone: '+77001112233' });
    const code = sentCode();
    assert.equal((await call('/api/shop/auth/verify-code', { phone: '+77001112233', code })).status, 200);
    const again = await call('/api/shop/auth/verify-code', { phone: '+77001112233', code });
    assert.equal(again.status, 400);
    assert.equal(again.json.reason, 'expired');
  });

  test('неверный код: 400, после 5 попыток даже верный не принимается', async () => {
    await call('/api/shop/auth/request-code', { phone: '+77001112233' });
    const code = sentCode();
    const wrong = code === '1234' ? '4321' : '1234';
    for (let i = 0; i < 5; i++) {
      const r = await call('/api/shop/auth/verify-code', { phone: '+77001112233', code: wrong });
      assert.equal(r.status, 400);
      assert.equal(r.json.reason, 'wrong_code');
    }
    const blocked = await call('/api/shop/auth/verify-code', { phone: '+77001112233', code });
    assert.equal(blocked.status, 429);
  });

  test('код для другого номера не подходит', async () => {
    devices.push({ phone: '77002223344', token: 'ExponentPushToken[other]' });
    await call('/api/shop/auth/request-code', { phone: '+77001112233' });
    const r = await call('/api/shop/auth/verify-code', { phone: '+77002223344', code: sentCode() });
    assert.equal(r.status, 400);
  });

  test('просроченный код: 400 expired', async () => {
    await call('/api/shop/auth/request-code', { phone: '+77001112233' });
    const code = sentCode();
    codes[0].expiresAt = new Date(Date.now() - 1000);
    const r = await call('/api/shop/auth/verify-code', { phone: '+77001112233', code });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, 'expired');
  });

  test('код не запрашивали: 400', async () => {
    const r = await call('/api/shop/auth/verify-code', { phone: '+77001112233', code: '1234' });
    assert.equal(r.status, 400);
  });
});
