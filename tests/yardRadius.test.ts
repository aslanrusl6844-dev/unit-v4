/**
 * Тесты радиуса «Двора» (YardShop.radiusMeters) на настоящем Express-приложении:
 * GET /api/shop/yard/nearby (radius покупателя + радиус магазина), GET /yard/shop/:id
 * (баннер, видео, бегущая строка, граница по радиусу магазина), POST /yard/orders
 * (проверка расстояния по радиусу магазина) и POST /yard/mine/settings.
 *
 * База данных НЕ используется: @prisma/client подменяется заглушкой в памяти.
 * Видео-инструкция для покупателей: GET /yard/instruction и /yard-admin/instruction.
 * Оплата, чат, «Принял», подписка и номер внутри заказа здесь не проверяются и
 * кода этих частей изменения не касаются.
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
const newId = () => `y${++seq}`;
const tables: { shop: Row[]; item: Row[]; order: Row[]; settings: Row[] } = { shop: [], item: [], order: [], settings: [] };

function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
}

const stub: Row = {
  yardShop: {
    findMany: async (a: Row = {}) => tables.shop.filter((r) => match(r, a.where)).map((r) => ({ ...r })),
    findUnique: async (a: Row) => {
      const r = tables.shop.find((x) => match(x, a.where));
      return r ? { ...r } : null;
    },
    update: async (a: Row) => {
      const r = tables.shop.find((x) => match(x, a.where));
      if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
      Object.assign(r, a.data);
      return { ...r };
    },
  },
  yardItem: {
    findMany: async (a: Row = {}) => {
      let rows = tables.item.filter((r) => match(r, a.where));
      if (a.take) rows = rows.slice(0, a.take);
      return rows.map((r) => ({ ...r }));
    },
  },
  yardSettings: {
    findUnique: async (a: Row) => {
      const r = tables.settings.find((x) => x.id === a.where.id);
      return r ? { ...r } : null;
    },
    upsert: async (a: Row) => {
      const r = tables.settings.find((x) => x.id === a.where.id);
      if (r) { Object.assign(r, a.update); return { ...r }; }
      const row = { ...a.create };
      tables.settings.push(row);
      return { ...row };
    },
  },
  yardOrder: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (a: Row) => {
      const row = { id: newId(), createdAt: new Date(), ...a.data, items: (a.data.items?.create ?? []).map((i: Row) => ({ id: newId(), ...i })) };
      tables.order.push(row);
      return { ...row };
    },
  },
};

class StubPrismaClient {
  constructor() {
    return new Proxy(this, {
      get(_t, key) {
        if (key === 'then') return undefined;
        if (key in stub) return stub[key as string];
        return new Proxy({}, { get: (_m, method) => async () => (/^find(First|Unique)/.test(String(method)) ? null : String(method) === 'count' ? 0 : []) });
      },
    });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { yardDistanceMeters } = require('../src/services/yard.service');

interface Res { status: number; json: any }
let port = 0;
let server: http.Server;
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-app-key': APP_KEY }): Promise<Res> {
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

// Магазин в точке (43.2, 76.9); покупатель смещается на север.
const SHOP_LAT = 43.2;
const SHOP_LNG = 76.9;
/** Точка покупателя на нужном расстоянии (метры) к северу от магазина. */
function at(meters: number): { lat: number; lng: number } {
  let lat = SHOP_LAT + meters / 111195;
  // уточняем по настоящей формуле сервера, чтобы расстояние было точным
  for (let i = 0; i < 5; i++) lat += (meters - yardDistanceMeters(lat, SHOP_LNG, SHOP_LAT, SHOP_LNG)) / 111195;
  return { lat, lng: SHOP_LNG };
}
const q = (m: number, extra = '') => { const p = at(m); return `lat=${p.lat}&lng=${p.lng}${extra}`; };

function seedShop(over: Row = {}): Row {
  const row: Row = {
    id: newId(), phone: `7700${String(seq).padStart(7, '0')}`, name: `Двор ${seq}`, photo: null,
    lat: SHOP_LAT, lng: SHOP_LNG, active: true, paidUntil: new Date(Date.now() + 86400_000),
    archived: false, radiusMeters: 500, bannerUrl: null, videoUrl: null, tickerText: null, ...over,
  };
  tables.shop.push(row);
  return row;
}
function seedItem(shopId: string, over: Row = {}): Row {
  const row: Row = { id: newId(), shopId, name: 'Хлеб', price: 200, stock: 10, photo: null, category: null, active: true, archived: false, ...over };
  tables.item.push(row);
  return row;
}
const ids = (r: Res) => (r.json as Row[]).map((s) => s.id);

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { tables.shop = []; tables.item = []; tables.order = []; tables.settings = []; });

describe('GET /yard/nearby — radius покупателя и радиус магазина', () => {
  test('без radius действует 500 м; магазин с радиусом 500 виден на 400 м и не виден на 600 м', async () => {
    const s = seedShop();
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(400)}`)), [s.id]);
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(600)}`)), []);
  });

  test('условие «расстояние ≤ radius покупателя И ≤ радиуса магазина»: все сочетания', async () => {
    const small = seedShop({ radiusMeters: 200, name: 'Малый' });
    const big = seedShop({ radiusMeters: 1000, name: 'Большой' });
    // покупатель на 250 м, выбрал радиус 1000: малый (200) не виден, большой виден
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(250, '&radius=1000')}`)), [big.id]);
    // покупатель на 250 м, выбрал 200: оба скрыты (дальше его радиуса)
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(250, '&radius=200')}`)), []);
    // покупатель на 150 м, радиус 200: оба видны
    assert.deepEqual((await call('GET', `/api/shop/yard/nearby?${q(150, '&radius=200')}`)).json.length, 2);
    void small;
  });

  test('большой чип покупателя не расширяет радиус магазина (500 м магазин на 700 м не виден при radius=1000)', async () => {
    seedShop({ radiusMeters: 500 });
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(700, '&radius=1000')}`)), []);
  });

  test('магазин на 1000 м виден на 800 м только если покупатель выбрал 1000 (по умолчанию 500 — нет)', async () => {
    const s = seedShop({ radiusMeters: 1000 });
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(800)}`)), []);
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(800, '&radius=1000')}`)), [s.id]);
  });

  test('граница: 299 м виден, 301 м не виден при радиусе магазина 300', async () => {
    const s = seedShop({ radiusMeters: 300 });
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(299, '&radius=1000')}`)), [s.id]);
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(301, '&radius=1000')}`)), []);
  });

  test('старая строка без radiusMeters считается 500 м', async () => {
    const s = seedShop();
    delete s.radiusMeters;
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(450)}`)), [s.id]);
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(550, '&radius=1000')}`)), []);
  });

  test('неверный radius → 400 (а не молчаливая подмена)', async () => {
    seedShop();
    for (const bad of ['abc', '0', '-5', 'NaN', 'Infinity', '1e9']) {
      const r = await call('GET', `/api/shop/yard/nearby?${q(100, `&radius=${bad}`)}`);
      assert.equal(r.status, 400, bad);
    }
  });

  test('формат ответа прежний (id, name, photo, meters, items), без телефона и новых полей; выключенные/без подписки скрыты', async () => {
    const s = seedShop({ bannerUrl: 'https://b/x.png', tickerText: 'акция' });
    seedItem(s.id);
    seedShop({ active: false });
    seedShop({ paidUntil: new Date(Date.now() - 1000) });
    const r = await call('GET', `/api/shop/yard/nearby?${q(100)}`);
    assert.equal(r.json.length, 1);
    assert.deepEqual(Object.keys(r.json[0]).sort(), ['id', 'items', 'meters', 'name', 'photo']);
    assert.equal(JSON.stringify(r.json).includes('phone'), false);
  });

  test('без x-app-key → 401', async () => {
    const r = await call('GET', `/api/shop/yard/nearby?${q(100)}`, undefined, {});
    assert.equal(r.status, 401);
  });
});

describe('GET /yard/shop/:id — полка, баннер, видео, строка', () => {
  test('отдаёт полку + bannerUrl, videoUrl, tickerText (null, если не заданы)', async () => {
    const s = seedShop({ bannerUrl: 'https://b/x.png', videoUrl: 'https://v/y.mp4', tickerText: 'Скидка 10%' });
    seedItem(s.id, { name: 'Молоко' });
    const r = await call('GET', `/api/shop/yard/shop/${s.id}?${q(100)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.bannerUrl, 'https://b/x.png');
    assert.equal(r.json.videoUrl, 'https://v/y.mp4');
    assert.equal(r.json.tickerText, 'Скидка 10%');
    assert.deepEqual(r.json.items.map((i: Row) => i.name), ['Молоко']);
    const plain = seedShop();
    const r2 = await call('GET', `/api/shop/yard/shop/${plain.id}?${q(100)}`);
    assert.equal(r2.json.bannerUrl, null);
    assert.equal(r2.json.videoUrl, null);
    assert.equal(r2.json.tickerText, null);
    assert.equal(JSON.stringify(r.json).includes('phone'), false);
  });

  test('дальше радиуса магазина — 403, внутри — 200 (радиус 200 / 1000)', async () => {
    const s200 = seedShop({ radiusMeters: 200 });
    const s1000 = seedShop({ radiusMeters: 1000 });
    assert.equal((await call('GET', `/api/shop/yard/shop/${s200.id}?${q(250)}`)).status, 403);
    assert.equal((await call('GET', `/api/shop/yard/shop/${s200.id}?${q(150)}`)).status, 200);
    assert.equal((await call('GET', `/api/shop/yard/shop/${s1000.id}?${q(900)}`)).status, 200);
    assert.equal((await call('GET', `/api/shop/yard/shop/${s1000.id}?${q(1100)}`)).status, 403);
  });

  test('скрытый, выключенный и неизвестный магазин → 404; без координат → 400', async () => {
    const off = seedShop({ active: false });
    assert.equal((await call('GET', `/api/shop/yard/shop/${off.id}?${q(10)}`)).status, 404);
    assert.equal((await call('GET', `/api/shop/yard/shop/nope?${q(10)}`)).status, 404);
    const s = seedShop();
    assert.equal((await call('GET', `/api/shop/yard/shop/${s.id}`)).status, 400);
  });
});

describe('POST /yard/orders — расстояние по радиусу магазина', () => {
  const order = (shopId: string, itemId: string, m: number) => ({
    shopId, ...at(m), buyerPhone: '+77001112233', buyerName: 'Покупатель', items: [{ itemId, qty: 1 }],
  });

  test('магазин на 1000 м принимает заказ с 700 м, магазин на 200 м — нет', async () => {
    const far = seedShop({ radiusMeters: 1000 });
    const near = seedShop({ radiusMeters: 200 });
    const i1 = seedItem(far.id);
    const i2 = seedItem(near.id);
    assert.equal((await call('POST', '/api/shop/yard/orders', order(far.id, i1.id, 700))).status, 201);
    const denied = await call('POST', '/api/shop/yard/orders', order(near.id, i2.id, 250));
    assert.equal(denied.status, 403);
    assert.equal(tables.order.length, 1);
  });

  test('заказ создаётся в прежнем статусе waiting_payment, телефон магазина в ответе не отдаётся, остаток не списывается', async () => {
    const s = seedShop();
    const it = seedItem(s.id, { stock: 5 });
    const r = await call('POST', '/api/shop/yard/orders', order(s.id, it.id, 100));
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'waiting_payment');
    assert.equal(JSON.stringify(r.json).includes(s.phone), false);
    assert.equal(tables.item[0].stock, 5);
  });
});

describe('POST /yard/mine/settings — кабинет магазина', () => {
  const save = (phone: string, body: Row) => call('POST', '/api/shop/yard/mine/settings', { phone, ...body });

  test('радиус только из 200 / 300 / 500 / 1000; сохраняется и применяется к выдаче', async () => {
    const s = seedShop({ phone: '77005550001' });
    for (const ok of [200, 300, 500, 1000]) {
      const r = await save('+77005550001', { radiusMeters: ok });
      assert.equal(r.status, 200, String(ok));
      assert.equal(r.json.radiusMeters, ok);
      assert.equal(tables.shop[0].radiusMeters, ok);
    }
    for (const bad of [0, 100, 250, 400, 1500, -1, '300', null]) {
      assert.equal((await save('+77005550001', { radiusMeters: bad })).status, 400, String(bad));
    }
    assert.equal(tables.shop[0].radiusMeters, 1000);
    await save('+77005550001', { radiusMeters: 200 });
    assert.deepEqual(ids(await call('GET', `/api/shop/yard/nearby?${q(250, '&radius=1000')}`)), []);
    void s;
  });

  test('баннер, видео, строка сохраняются отдельно; пустая строка/null очищают; остальные поля не трогаются', async () => {
    const s = seedShop({ phone: '77005550002', name: 'Мой двор', radiusMeters: 300 });
    let r = await save('+77005550002', { bannerUrl: 'https://b/x.png' });
    assert.equal(r.json.bannerUrl, 'https://b/x.png');
    assert.equal(tables.shop[0].radiusMeters, 300);
    r = await save('+77005550002', { videoUrl: 'https://v/y.mp4', tickerText: '  Акция дня  ' });
    assert.equal(r.json.videoUrl, 'https://v/y.mp4');
    assert.equal(r.json.tickerText, 'Акция дня');
    assert.equal(r.json.bannerUrl, 'https://b/x.png');
    r = await save('+77005550002', { bannerUrl: '', videoUrl: null, tickerText: '   ' });
    assert.equal(r.json.bannerUrl, null);
    assert.equal(r.json.videoUrl, null);
    assert.equal(r.json.tickerText, null);
    assert.equal(s.name, 'Мой двор');
    assert.equal(s.lat, SHOP_LAT);
    assert.equal(s.radiusMeters, 300);
  });

  test('проверка данных: не-http ссылки, слишком длинное, пустое тело → 400; база не меняется', async () => {
    const s = seedShop({ phone: '77005550003', bannerUrl: 'https://b/old.png' });
    for (const body of [
      { bannerUrl: 'javascript:alert(1)' }, { videoUrl: 'ftp://x/y.mp4' }, { videoUrl: 'не ссылка' },
      { bannerUrl: 'https://b/' + 'a'.repeat(2100) }, { tickerText: 'я'.repeat(301) }, {},
    ]) {
      assert.equal((await save('+77005550003', body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(s.bannerUrl, 'https://b/old.png');
  });

  test('чужой/неизвестный телефон (магазин не одобрен) → 404; некорректный номер → 400; без x-app-key → 401', async () => {
    seedShop({ phone: '77005550004' });
    assert.equal((await save('+77009999999', { radiusMeters: 300 })).status, 404);
    assert.equal((await save('abc', { radiusMeters: 300 })).status, 400);
    const noKey = await call('POST', '/api/shop/yard/mine/settings', { phone: '+77005550004', radiusMeters: 300 }, {});
    assert.equal(noKey.status, 401);
    assert.equal(tables.shop[0].radiusMeters, 500);
  });

  test('кабинет GET /yard/mine отдаёт магазин с новыми полями', async () => {
    seedShop({ phone: '77005550005', radiusMeters: 300, bannerUrl: 'https://b/x.png' });
    const r = await call('GET', '/api/shop/yard/mine?phone=%2B77005550005');
    assert.equal(r.status, 200);
    assert.equal(r.json.shop.radiusMeters, 300);
    assert.equal(r.json.shop.bannerUrl, 'https://b/x.png');
    assert.equal(r.json.shop.videoUrl, null);
  });
});

describe('видео-инструкция для покупателей (одна на сервер)', () => {
  const AUTH = { authorization: 'Basic ' + Buffer.from(`admin-test:${process.env.ADMIN_PASSWORD}`).toString('base64') };
  const VIDEO = 'https://cdn.example/how-to.mp4';
  const adminSave = (body: unknown) => call('POST', '/api/yard-admin/instruction', body, AUTH);
  const buyerGet = () => call('GET', '/api/shop/yard/instruction');

  test('пока ссылки нет — { videoUrl: null }', async () => {
    const r = await buyerGet();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { videoUrl: null });
  });

  test('админ сохраняет ссылку → покупатель получает её; одна строка на весь сервер', async () => {
    const r = await adminSave({ videoUrl: `  ${VIDEO}  ` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { videoUrl: VIDEO });
    assert.deepEqual((await buyerGet()).json, { videoUrl: VIDEO });
    await adminSave({ videoUrl: 'https://cdn.example/second.mp4' });
    assert.equal(tables.settings.length, 1);
    assert.deepEqual((await buyerGet()).json, { videoUrl: 'https://cdn.example/second.mp4' });
    assert.deepEqual((await call('GET', '/api/yard-admin/instruction', undefined, AUTH)).json, { videoUrl: 'https://cdn.example/second.mp4' });
  });

  test('пустая строка и null очищают → снова null', async () => {
    await adminSave({ videoUrl: VIDEO });
    assert.deepEqual((await adminSave({ videoUrl: '' })).json, { videoUrl: null });
    assert.deepEqual((await buyerGet()).json, { videoUrl: null });
    await adminSave({ videoUrl: VIDEO });
    assert.deepEqual((await adminSave({ videoUrl: null })).json, { videoUrl: null });
    assert.deepEqual((await adminSave({ videoUrl: '   ' })).json, { videoUrl: null });
  });

  test('проверка ссылки: не http(s), не строка, нет поля, слишком длинная → 400 и значение не меняется', async () => {
    await adminSave({ videoUrl: VIDEO });
    for (const body of [{ videoUrl: 'javascript:alert(1)' }, { videoUrl: 'ftp://x/y.mp4' }, { videoUrl: 'не ссылка' },
      { videoUrl: 5 }, {}, { videoUrl: 'https://x/' + 'a'.repeat(2100) }]) {
      assert.equal((await adminSave(body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.deepEqual((await buyerGet()).json, { videoUrl: VIDEO });
  });

  test('запись — только для админа: без входа 401, x-app-key вместо входа не годится, ничего не меняется', async () => {
    assert.equal((await call('POST', '/api/yard-admin/instruction', { videoUrl: VIDEO }, {})).status, 401);
    assert.equal((await call('POST', '/api/yard-admin/instruction', { videoUrl: VIDEO }, { 'x-app-key': APP_KEY })).status, 401);
    assert.equal((await call('GET', '/api/yard-admin/instruction', undefined, {})).status, 401);
    assert.equal(tables.settings.length, 0);
  });

  test('чтение покупателем требует x-app-key; телефон не нужен', async () => {
    assert.equal((await call('GET', '/api/shop/yard/instruction', undefined, {})).status, 401);
    assert.equal((await buyerGet()).status, 200);
  });

  test('настройки магазинов и радиус инструкция не затрагивает', async () => {
    const s = seedShop({ radiusMeters: 300, videoUrl: 'https://v/shop.mp4' });
    await adminSave({ videoUrl: VIDEO });
    assert.equal(tables.shop[0].videoUrl, 'https://v/shop.mp4');
    assert.equal(tables.shop[0].radiusMeters, 300);
    const page = (await call('GET', `/api/shop/yard/shop/${s.id}?${q(100)}`)).json;
    assert.equal(page.videoUrl, 'https://v/shop.mp4');
  });
});
