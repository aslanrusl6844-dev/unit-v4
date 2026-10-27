/** Слайды городов (до 10): админка /api/shop-admin/city-images и GET /api/shop/city-images. БД — заглушка в памяти. */
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
let slides: Row[] = [];
let seq = 0;
let failDb = false;

const chk = () => { if (failDb) throw new Error('db down'); };
const sorted = (a: Row[]) => [...a].sort((x, y) => x.position - y.position || x.createdAt - y.createdAt);
const stub: Row = {
  cityImageSlide: {
    findMany: async (a: Row = {}) => {
      chk();
      let r = slides.filter((x) => !a.where?.city || x.city === a.where.city);
      r = sorted(r);
      if (a.take) r = r.slice(0, a.take);
      return r.map((x) => ({ ...x }));
    },
    create: async (a: Row) => { chk(); const r = { id: `s${++seq}`, createdAt: seq, ...a.data }; slides.push(r); return { ...r }; },
    deleteMany: async (a: Row) => { chk(); const n = slides.length; slides = slides.filter((x) => !(x.id === a.where.id && x.city === a.where.city)); return { count: n - slides.length }; },
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
const enc = encodeURIComponent;
const pubList = (city?: string) => call('GET', '/api/shop/city-images' + (city === undefined ? '' : `?city=${enc(city)}`));
const pubOne = (city?: string) => call('GET', '/api/shop/city-image' + (city === undefined ? '' : `?city=${enc(city)}`));
const u = (n: number) => `https://blob.example.com/city/${n}.jpg`;
const add = (city: string, n: number) => call('POST', `${ADM}/${enc(city)}`, { imageUrl: u(n) }, ADMIN);

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { slides = []; seq = 0; failDb = false; });

describe('админка «Картинки городов» (слайды)', () => {
  test('без Basic-авторизации — 401, ничего не меняется', async () => {
    assert.equal((await call('GET', ADM, undefined, {})).status, 401);
    assert.equal((await call('POST', `${ADM}/${enc('Алматы')}`, { imageUrl: u(1) }, { 'x-app-key': APP_KEY })).status, 401);
    assert.equal((await call('DELETE', `${ADM}/${enc('Алматы')}/s1`, undefined, {})).status, 401);
    assert.equal(slides.length, 0);
  });

  test('список: 20 городов в заданном порядке, images пустой массив', async () => {
    const r = await call('GET', ADM, undefined, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 20);
    assert.deepEqual(r.json.slice(0, 3).map((x: Row) => x.city), ['Алматы', 'Астана', 'Шымкент']);
    assert.equal(r.json[19].city, 'Жезказган');
    assert.ok(r.json.every((x: Row) => Array.isArray(x.images) && x.images.length === 0 && x.imageUrl === null && x.max === 10));
  });

  test('«Добавить» добавляет по одной, порядок сохраняется, у других городов не появляется', async () => {
    let r = await add('Усть-Каменогорск', 1);
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.images.map((i: Row) => i.url), [u(1)]);
    r = await add('Усть-Каменогорск', 2);
    assert.deepEqual(r.json.images.map((i: Row) => i.url), [u(1), u(2)]);
    assert.ok(r.json.images.every((i: Row) => typeof i.id === 'string'));
    await add('Астана', 9);
    const list = await call('GET', ADM, undefined, ADMIN);
    const uk = list.json.find((x: Row) => x.city === 'Усть-Каменогорск');
    assert.deepEqual(uk.images.map((i: Row) => i.url), [u(1), u(2)]);
    assert.equal(uk.imageUrl, u(1));
    assert.equal(list.json.find((x: Row) => x.city === 'Астана').images.length, 1);
    assert.equal(list.json.find((x: Row) => x.city === 'Алматы').images.length, 0);
  });

  test('лимит: 10 можно, 11-я — 400 и не сохраняется', async () => {
    for (let n = 1; n <= 10; n++) assert.equal((await add('Алматы', n)).status, 201, String(n));
    const r = await add('Алматы', 11);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /10/);
    assert.equal(slides.filter((x) => x.city === 'Алматы').length, 10);
    assert.equal((await add('Астана', 1)).status, 201); // лимит — на город
  });

  test('удаление любой картинки; после удаления можно добавить снова; порядок остальных сохраняется', async () => {
    await add('Алматы', 1); await add('Алматы', 2); await add('Алматы', 3);
    const list = (await call('GET', ADM, undefined, ADMIN)).json.find((x: Row) => x.city === 'Алматы').images;
    const mid = list[1].id;
    const r = await call('DELETE', `${ADM}/${enc('Алматы')}/${mid}`, undefined, ADMIN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.images.map((i: Row) => i.url), [u(1), u(3)]);
    assert.equal((await call('DELETE', `${ADM}/${enc('Алматы')}/${mid}`, undefined, ADMIN)).status, 200); // повтор не падает
    await add('Алматы', 4);
    assert.deepEqual((await pubList('Алматы')).json, [u(1), u(3), u(4)]);
  });

  test('картинка другого города по id не удаляется', async () => {
    await add('Астана', 1);
    const id = slides[0].id;
    await call('DELETE', `${ADM}/${enc('Алматы')}/${id}`, undefined, ADMIN);
    assert.equal(slides.length, 1);
  });

  test('валидация: не-https, пустая, чужой город', async () => {
    const p = `${ADM}/${enc('Алматы')}`;
    for (const bad of ['http://x.kz/a.jpg', 'javascript:alert(1)', '', '   ', 'https://']) {
      assert.equal((await call('POST', p, { imageUrl: bad }, ADMIN)).status, 400, bad);
    }
    assert.equal((await call('POST', p, {}, ADMIN)).status, 400);
    assert.equal((await call('POST', `${ADM}/${enc('Москва')}`, { imageUrl: u(1) }, ADMIN)).status, 404);
    assert.equal((await call('DELETE', `${ADM}/${enc('Москва')}/s1`, undefined, ADMIN)).status, 404);
    assert.equal(slides.length, 0);
  });

  test('ошибка БД → 500 с понятным сообщением', async () => {
    failDb = true;
    const r = await call('GET', ADM, undefined, ADMIN);
    assert.equal(r.status, 500);
    assert.ok(r.json.error);
  });
});

describe('GET /api/shop/city-images и /city-image', () => {
  test('нужен x-app-key', async () => {
    assert.equal((await call('GET', `/api/shop/city-images?city=${enc('Алматы')}`, undefined, {})).status, 401);
  });

  test('массив url в порядке показа; нет картинок → []', async () => {
    await add('Алматы', 1); await add('Алматы', 2); await add('Алматы', 3);
    assert.deepEqual((await pubList('Алматы')).json, [u(1), u(2), u(3)]);
    assert.deepEqual((await pubList('Астана')).json, []);
    assert.equal((await pubList('Астана')).status, 200);
  });

  test('регистр, ё/е, дефис/пробелы, старые названия', async () => {
    await add('Алматы', 1); await add('Усть-Каменогорск', 2); await add('Астана', 3);
    for (const c of ['алматы', 'АЛМАТЫ', '  Алматы ', 'Алма-Ата']) assert.deepEqual((await pubList(c)).json, [u(1)], c);
    for (const c of ['усть-каменогорск', 'Усть Каменогорск', 'УСТЬ–КАМЕНОГОРСК']) assert.deepEqual((await pubList(c)).json, [u(2)], c);
    for (const c of ['Нур-Султан', 'Нурсултан']) assert.deepEqual((await pubList(c)).json, [u(3)], c);
  });

  test('неизвестный город, пустой и отсутствующий параметр → []', async () => {
    await add('Алматы', 1);
    for (const c of ['Москва', '', '   ']) assert.deepEqual((await pubList(c)).json, [], c);
    assert.deepEqual((await pubList()).json, []);
    assert.deepEqual((await call('GET', '/api/shop/city-images?city=a&city=b')).json, []);
  });

  test('сбой БД не ломает приложение → []', async () => {
    failDb = true;
    const r = await pubList('Алматы');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
  });

  test('прежний /city-image отдаёт первую картинку или { imageUrl: null }', async () => {
    await add('Алматы', 1); await add('Алматы', 2);
    assert.deepEqual((await pubOne('Алматы')).json, { imageUrl: u(1) });
    assert.deepEqual((await pubOne('Астана')).json, { imageUrl: null });
    assert.deepEqual((await pubOne('Москва')).json, { imageUrl: null });
    failDb = true;
    assert.deepEqual((await pubOne('Алматы')).json, { imageUrl: null });
  });

  test('соседний /products/:sku не затронут', async () => {
    const r = await call('GET', '/api/shop/products/nope');
    assert.notEqual(r.status, 401);
  });
});
