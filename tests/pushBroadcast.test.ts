/**
 * Админская рассылка пушей (/api/push-admin): картинка попадает в payload Expo
 * только когда задана; без неё — обычный пуш. БД и Expo — заглушки.
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
let tokens: Row[] = [];
const stub: Row = {
  shopCustomerPushToken: {
    findMany: async () => tokens.map((r) => ({ ...r })),
    findUnique: async (a: Row) => {
      const r = tokens.find((x) => x.phone === a.where.phone);
      return r ? { ...r } : null;
    },
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

// --- заглушка Expo: подменяем fetch только для адреса exp.host ---
let expoCalls: Row[][] = [];
let expoMode: 'ok' | 'error' | 'notRegistered' | 'http500' = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).startsWith('https://exp.host/')) {
    const msgs: Row[] = JSON.parse(init.body);
    expoCalls.push(msgs);
    if (expoMode === 'http500') return new Response('{}', { status: 500 });
    const data = msgs.map(() =>
      expoMode === 'ok' ? { status: 'ok', id: 'x' }
        : expoMode === 'notRegistered' ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
          : { status: 'error', message: 'bad' });
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
}) as typeof fetch;

let port = 0;
let server: http.Server;
const AUTH = { authorization: 'Basic ' + Buffer.from(`admin-test:${process.env.ADMIN_PASSWORD}`).toString('base64'), 'sec-fetch-site': 'same-origin' };
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h: Record<string, string> = { ...headers };
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
const tok = (i: number) => `ExponentPushToken[abc${i}]`;
before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => { globalThis.fetch = realFetch; return new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { tokens = []; expoCalls = []; expoMode = 'ok'; });

describe('POST /api/push-admin/send', () => {
  test('с картинкой: в сообщении Expo есть richContent.image и data.image, заголовок и текст на месте', async () => {
    tokens = [{ phone: '77001112233', token: tok(1) }];
    const r = await call('POST', '/api/push-admin/send', { title: 'Акция', body: 'Скидки', imageUrl: 'https://blob.example/a.jpg', audience: 'test', testPhone: '+7 700 111 22 33' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sent, 1);
    assert.equal(r.json.withImage, true);
    const m = expoCalls[0][0];
    assert.equal(m.to, tok(1));
    assert.equal(m.title, 'Акция');
    assert.equal(m.body, 'Скидки');
    assert.deepEqual(m.richContent, { image: 'https://blob.example/a.jpg' });
    assert.equal(m.data.image, 'https://blob.example/a.jpg');
  });

  test('без картинки (нет поля / null / пустая строка): пуш обычный, без richContent и image', async () => {
    tokens = [{ phone: '77001112233', token: tok(1) }];
    for (const extra of [{}, { imageUrl: null }, { imageUrl: '' }]) {
      expoCalls = [];
      const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'test', testPhone: '77001112233', ...extra });
      assert.equal(r.status, 200, JSON.stringify(extra));
      assert.equal(r.json.withImage, false);
      const m = expoCalls[0][0];
      assert.ok(!('richContent' in m));
      assert.ok(!('image' in m.data));
      assert.equal(m.title, 'T');
    }
  });

  test('«всем»: 250 токенов → 3 запроса к Expo (по ≤100), не-Expo токены пропущены, дубли убраны', async () => {
    tokens = Array.from({ length: 250 }, (_, i) => ({ phone: `7700${i}`, token: tok(i) }));
    tokens.push({ phone: 'x1', token: 'fcm-native-token' }, { phone: 'x2', token: tok(0) });
    const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', imageUrl: 'https://b/x.png', audience: 'all' });
    assert.equal(r.status, 200);
    assert.equal(r.json.sent, 250);
    assert.equal(r.json.skippedNotExpo, 1);
    assert.deepEqual(expoCalls.map((c) => c.length).sort((a, b) => b - a), [100, 100, 50]);
    assert.ok(expoCalls.flat().every((m) => m.richContent.image === 'https://b/x.png'));
  });

  test('ошибки Expo считаются: DeviceNotRegistered отдельно, HTTP 500 — все failed', async () => {
    tokens = [{ phone: '1', token: tok(1) }, { phone: '2', token: tok(2) }];
    expoMode = 'notRegistered';
    let r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.deepEqual([r.json.sent, r.json.failed, r.json.notRegistered], [0, 2, 2]);
    expoMode = 'http500';
    r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.deepEqual([r.json.sent, r.json.failed], [0, 2]);
  });

  test('валидация: нет заголовка/текста/audience, картинка не https, тест без номера или без токена', async () => {
    tokens = [{ phone: '77001112233', token: tok(1) }];
    const bad: Row[] = [
      { body: 'B', audience: 'all' },
      { title: 'T', audience: 'all' },
      { title: 'T', body: 'B' },
      { title: 'T', body: 'B', audience: 'everyone' },
      { title: 'T', body: 'B', audience: 'all', imageUrl: 'http://insecure/x.jpg' },
      { title: 'T', body: 'B', audience: 'all', imageUrl: 'javascript:1' },
      { title: 'T', body: 'B', audience: 'test' },
    ];
    for (const b of bad) assert.equal((await call('POST', '/api/push-admin/send', b)).status, 400, JSON.stringify(b));
    const none = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'test', testPhone: '77009999999' });
    assert.equal(none.status, 404);
    assert.equal(expoCalls.length, 0, 'при отказе в Expo ничего не уходит');
  });

  test('нет получателей → 404, Expo не вызывается', async () => {
    const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.equal(r.status, 404);
    assert.equal(expoCalls.length, 0);
  });

  test('без админ-входа запрещено (401), в том числе с x-app-key приложения', async () => {
    tokens = [{ phone: '1', token: tok(1) }];
    const body = { title: 'T', body: 'B', audience: 'all' };
    assert.equal((await call('POST', '/api/push-admin/send', body, {})).status, 401);
    assert.equal((await call('POST', '/api/push-admin/send', body, { 'x-app-key': process.env.SHOP_APP_KEY! })).status, 401);
    assert.equal((await call('GET', '/api/push-admin/audience', undefined, {})).status, 401);
    assert.equal(expoCalls.length, 0);
  });
});

describe('GET /api/push-admin/audience', () => {
  test('считает все токены и только Expo-токены', async () => {
    tokens = [{ phone: '1', token: tok(1) }, { phone: '2', token: 'fcm' }];
    const r = await call('GET', '/api/push-admin/audience');
    assert.deepEqual(r.json, { total: 2, expo: 1 });
  });
});
