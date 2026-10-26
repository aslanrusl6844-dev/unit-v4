/** Картинки городов: админка (/api/shop-admin/city-images) и GET /api/shop/city-image. БД — заглушка в памяти. */
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
let rows = new Map<string, Row>();
let failDb = false;

const chk = () => { if (failDb) throw new Error('db down'); };
const stub: Row = {
  cityImage: {
    findMany: async () => { chk(); return [...rows.values()].map((r) => ({ ...r })); },
    findUnique: async (a: Row) => { chk(); const r = rows.get(a.where.city); return r ? { ...r } : null; },
    upsert: async (a: Row) => { chk(); const r = { ...(rows.get(a.where.city) ?? a.create), ...(rows.has(a.where.city) ? a.update : {}), updatedAt: new Date() }; rows.set(a.where.city, r); return { ...r }; },
    deleteMany: async (a: Row) => { chk(); const had = rows.delete(a.where.city); return { count: had ? 1 : 0 }; },
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

let port = 0;
let server: http.Server;
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-app-key': APP_KEY }): Promise<{ status: number; json: any }> {
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
const ADMIN = { authorization: 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString('base64') };
const ADM = '/api/shop-admin/city-images';
const pub = (city?: string) => call('GET', '/api/shop/city-image' + (city === undefined ? '' : `?city=${encodeURIComponent(city)}`));
const URL1 = 'https://blob.example.com/city/almaty.jpg';

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { rows = new Map(); failDb = false; });

describe('админка «Картинки городов»', () => {
  test('без Basic-авторизации — 401, ничего не меняется', async () => {
    assert.equal((await call('GET', ADM, undefined, {})).status, 401);
    assert.equal((await call('PUT', `${ADM}/${encodeURIComponent('Алматы')}`, { imageUrl: URL1 }, { 'x-app-key': APP_KEY })).status, 401);
    assert.equal((await call('DELETE', `${ADM}/${encodeURIComponent('Алматы')}`, undefined, {})).status, 401);
    assert.equal(rows.size, 0);
  });

  test('список: 20 городов в заданном порядке, у незагруженных imageUrl null', async () => {
    const r = await call('GET', ADM, undefined, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 20);
    assert.deepEqual(r.json.slice(0, 3).map((x: Row) => x.city), ['Алматы', 'Астана', 'Шымкент']);
    assert.equal(r.json[19].city, 'Жезказган');
    assert.ok(r.json.every((x: Row) => x.imageUrl === null));
  });

  test('загрузка, замена и удаление', async () => {
    const p = `${ADM}/${encodeURIComponent('Усть-Каменогорск')}`;
    let r = await call('PUT', p, { imageUrl: URL1 }, ADMIN);
    assert.deepEqual(r.json, { city: 'Усть-Каменогорск', imageUrl: URL1 });
    r = await call('PUT', p, { imageUrl: 'https://blob.example.com/new.png' }, ADMIN);
    assert.equal(r.json.imageUrl, 'https://blob.example.com/new.png');
    assert.equal(rows.size, 1);
    const list = await call('GET', ADM, undefined, ADMIN);
    assert.equal(list.json.find((x: Row) => x.city === 'Усть-Каменогорск').imageUrl, 'https://blob.example.com/new.png');
    assert.equal(list.json.filter((x: Row) => x.imageUrl).length, 1);
    r = await call('DELETE', p, undefined, ADMIN);
    assert.deepEqual(r.json, { ok: true, city: 'Усть-Каменогорск', imageUrl: null });
    assert.equal(rows.size, 0);
    assert.equal((await call('DELETE', p, undefined, ADMIN)).status, 200); // повторное удаление не падает
  });

  test('валидация: не-https, пустая, чужой город', async () => {
    const p = `${ADM}/${encodeURIComponent('Алматы')}`;
    for (const bad of ['http://x.kz/a.jpg', 'javascript:alert(1)', '', '   ', 'https://']) {
      assert.equal((await call('PUT', p, { imageUrl: bad }, ADMIN)).status, 400, bad);
    }
    assert.equal((await call('PUT', p, {}, ADMIN)).status, 400);
    assert.equal((await call('PUT', `${ADM}/${encodeURIComponent('Москва')}`, { imageUrl: URL1 }, ADMIN)).status, 404);
    assert.equal((await call('DELETE', `${ADM}/${encodeURIComponent('Москва')}`, undefined, ADMIN)).status, 404);
    assert.equal(rows.size, 0);
  });

  test('ошибка БД → 500 с понятным сообщением', async () => {
    failDb = true;
    const r = await call('GET', ADM, undefined, ADMIN);
    assert.equal(r.status, 500);
    assert.ok(r.json.error);
  });
});

describe('GET /api/shop/city-image', () => {
  test('нужен x-app-key', async () => {
    assert.equal((await call('GET', '/api/shop/city-image?city=Алматы'.replace('Алматы', encodeURIComponent('Алматы')), undefined, {})).status, 401);
  });

  test('есть картинка → { imageUrl }, нет → { imageUrl: null }', async () => {
    rows.set('Алматы', { city: 'Алматы', imageUrl: URL1 });
    assert.deepEqual((await pub('Алматы')).json, { imageUrl: URL1 });
    assert.deepEqual((await pub('Астана')).json, { imageUrl: null });
  });

  test('регистр, ё/е, дефис/пробелы, старые названия', async () => {
    rows.set('Алматы', { city: 'Алматы', imageUrl: URL1 });
    rows.set('Усть-Каменогорск', { city: 'Усть-Каменогорск', imageUrl: 'https://b.example.com/u.jpg' });
    rows.set('Астана', { city: 'Астана', imageUrl: 'https://b.example.com/a.jpg' });
    for (const c of ['алматы', 'АЛМАТЫ', '  Алматы ', 'Алма-Ата']) assert.equal((await pub(c)).json.imageUrl, URL1, c);
    for (const c of ['усть-каменогорск', 'Усть Каменогорск', 'УСТЬ–КАМЕНОГОРСК']) assert.equal((await pub(c)).json.imageUrl, 'https://b.example.com/u.jpg', c);
    for (const c of ['Нур-Султан', 'Нурсултан']) assert.equal((await pub(c)).json.imageUrl, 'https://b.example.com/a.jpg', c);
  });

  test('неизвестный город, пустой и отсутствующий параметр → { imageUrl: null }', async () => {
    rows.set('Алматы', { city: 'Алматы', imageUrl: URL1 });
    for (const c of ['Москва', '', '   ']) assert.deepEqual((await pub(c)).json, { imageUrl: null }, c);
    assert.deepEqual((await pub()).json, { imageUrl: null });
    assert.deepEqual((await call('GET', '/api/shop/city-image?city=a&city=b')).json, { imageUrl: null });
  });

  test('сбой БД не ломает приложение → { imageUrl: null }', async () => {
    failDb = true;
    const r = await pub('Алматы');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { imageUrl: null });
  });

  test('соседний /products/:sku не затронут', async () => {
    const r = await call('GET', '/api/shop/products/nope');
    assert.notEqual(r.status, 401);
  });
});
