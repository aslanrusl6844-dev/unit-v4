/**
 * Варианты количества (Product.quantityVariants) и рич-контент «Детали»
 * (Product.details — массив URL фото/видео, Json): админский PUT/POST /api/products и публичные
 * GET /api/shop/products[/:sku]. БД — заглушка в памяти.
 * Существующий ключ `variants` (цвет/размер) этим кодом не меняется.
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
let products: Row[] = [];
let seq = 0;

const stub: Row = {
  product: {
    findMany: async () => products.map((r) => ({ ...r })),
    findFirst: async (a: Row = {}) => {
      const ors: Row[] = a.where?.OR ?? [];
      const r = products.find((x) => ors.some((o) => Object.entries(o).every(([k, v]) => x[k] === v)));
      return r ? { ...r } : null;
    },
    findUnique: async (a: Row) => {
      const r = products.find((x) => x.id === a.where.id);
      return r ? { ...r } : null;
    },
    create: async (a: Row) => {
      const row = { id: `p${++seq}`, ...a.data };
      products.push(row);
      return { ...row };
    },
    update: async (a: Row) => {
      const r = products.find((x) => x.id === a.where.id);
      if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
      Object.assign(r, a.data);
      return { ...r };
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
const { parseQuantityVariants, parseDetails } = require('../src/services/productExtras');

interface Res { status: number; json: any }
let port = 0;
let server: http.Server;
const AUTH = { authorization: 'Basic ' + Buffer.from(`admin-test:${process.env.ADMIN_PASSWORD}`).toString('base64') };
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
const admin = (m: string, p: string, b?: unknown) => call(m, p, b, { ...AUTH, 'sec-fetch-site': 'same-origin' });

function seed(over: Row = {}): Row {
  const row: Row = {
    id: `p${++seq}`, sku: `sku-${seq}`, name: 'Чай', shopArticle: String(1000000 + seq), shopPrice: 500, shopActive: true,
    shopArchived: false, category: 'Продукты', type: 'Чай', images: null, quantityVariants: null, details: null, ...over,
  };
  products.push(row);
  return row;
}
before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { products = []; });

describe('публичный ответ товара', () => {
  test('нет данных → quantityVariants и details пустые массивы (список и карточка)', async () => {
    const p = seed();
    const list = await call('GET', '/api/shop/products');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json[0].quantityVariants, []);
    assert.deepEqual(list.json[0].details, []);
    const one = await call('GET', `/api/shop/products/${p.shopArticle}`);
    assert.deepEqual(one.json.quantityVariants, []);
    assert.deepEqual(one.json.details, []);
  });

  test('details не содержит обычные фото товара; карточка находится и по id', async () => {
    const p = seed({ images: JSON.stringify(['https://a/main.jpg']), details: ['https://a/d1.jpg'] });
    const r = await call('GET', `/api/shop/products/${p.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.details, ['https://a/d1.jpg']);
    assert.deepEqual(r.json.images, ['https://a/main.jpg']);
    const q = seed({ images: JSON.stringify(['https://a/other.jpg']) });
    assert.deepEqual((await call('GET', `/api/shop/products/${q.shopArticle}`)).json.details, []);
  });

  test('отдаёт варианты {quantity, unit, price} и детали {type, url} в сохранённом порядке', async () => {
    const p = seed({
      quantityVariants: JSON.stringify([{ quantity: 1, unit: 'шт', price: 500 }, { quantity: 2, unit: 'шт', price: 900 }]),
      details: ['https://x.kz/a.mp4', 'https://x.kz/1.jpg', 'https://x.kz/c.png'],
    });
    const r = await call('GET', `/api/shop/products/${p.shopArticle}`);
    assert.deepEqual(r.json.quantityVariants, [{ quantity: 1, unit: 'шт', price: 500 }, { quantity: 2, unit: 'шт', price: 900 }]);
    assert.deepEqual(r.json.details, ['https://x.kz/a.mp4', 'https://x.kz/1.jpg', 'https://x.kz/c.png']);
    assert.equal(r.json.price, 500, 'обычная цена не меняется');
  });

  test('существующий ключ variants (цвет/размер) не перетирается', async () => {
    const p = seed({ quantityVariants: JSON.stringify([{ quantity: 1, unit: 'кг', price: 100 }]) });
    const r = await call('GET', `/api/shop/products/${p.shopArticle}`);
    assert.ok(!('variants' in r.json) || r.json.variants === undefined || Array.isArray(r.json.variants));
    assert.equal(r.json.quantityVariants[0].unit, 'кг');
  });

  test('битый JSON и мусорные элементы → [] / отбрасываются, без 500', async () => {
    seed({ quantityVariants: '{oops', details: 'not json' });
    seed({ quantityVariants: JSON.stringify([{ quantity: -1, price: 5 }, { quantity: 3, unit: 'шт', price: 10 }]), details: [5, null, 'javascript:1', 'https://ok/1.jpg'] });
    const r = await call('GET', '/api/shop/products');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json[0].quantityVariants, []);
    assert.deepEqual(r.json[0].details, []);
    assert.deepEqual(r.json[1].quantityVariants, [{ quantity: 3, unit: 'шт', price: 10 }]);
    assert.deepEqual(r.json[1].details, ['https://ok/1.jpg']);
  });

  test('без x-app-key публичный ответ по-прежнему закрыт', async () => {
    seed();
    const r = await call('GET', '/api/shop/products', undefined, {});
    assert.ok(r.status === 401 || r.status === 403);
  });
});

describe('админка: сохранение массивов', () => {
  test('PUT сохраняет варианты и детали (JSON в БД), публичный ответ их отдаёт', async () => {
    const p = seed();
    const body = {
      quantityVariants: [{ quantity: 1, unit: 'шт', price: 500 }, { quantity: 2, price: 900 }],
      details: ['https://x.kz/1.jpg', 'https://x.kz/v.mp4'],
    };
    const put = await admin('PUT', `/api/products/${p.id}`, body);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(typeof products[0].quantityVariants, 'string');
    const pub = await call('GET', `/api/shop/products/${p.shopArticle}`);
    assert.deepEqual(pub.json.quantityVariants, [{ quantity: 1, unit: 'шт', price: 500 }, { quantity: 2, unit: 'шт', price: 900 }]);
    assert.deepEqual(pub.json.details, body.details);
  });

  test('убрать всё: пустые массивы → null в БД → [] в ответе', async () => {
    const p = seed({ quantityVariants: JSON.stringify([{ quantity: 1, unit: 'шт', price: 1 }]), details: ['https://a/1.jpg'] });
    const put = await admin('PUT', `/api/products/${p.id}`, { quantityVariants: [], details: [] });
    assert.equal(put.status, 200);
    assert.equal(products[0].quantityVariants, null);
    assert.deepEqual(products[0].details, []);
    const pub = await call('GET', `/api/shop/products/${p.shopArticle}`);
    assert.deepEqual(pub.json.quantityVariants, []);
    assert.deepEqual(pub.json.details, []);
  });

  test('порядок деталей сохраняется как прислан', async () => {
    const p = seed();
    const details = ['https://a/c.png', 'https://a/p.jpg', 'https://a/v.mp4'];
    await admin('PUT', `/api/products/${p.id}`, { details });
    assert.deepEqual(parseDetails(products[0].details), details);
  });

  test('PUT без этих полей (старый клиент) не трогает сохранённые данные', async () => {
    const qv = JSON.stringify([{ quantity: 1, unit: 'шт', price: 1 }]);
    const p = seed({ quantityVariants: qv });
    const put = await admin('PUT', `/api/products/${p.id}`, { name: 'Новое имя' });
    assert.equal(put.status, 200);
    assert.equal(products[0].quantityVariants, qv);
  });

  test('POST создаёт товар с вариантами', async () => {
    const r = await admin('POST', '/api/products', { sku: 'new-1', name: 'Новый', costPrice: 1, quantityVariants: [{ quantity: 3, unit: 'шт', price: 10 }] });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json));
    assert.deepEqual(parseQuantityVariants(products[0].quantityVariants), [{ quantity: 3, unit: 'шт', price: 10 }]);
  });

  test('валидация: плохие данные → 400 и в БД ничего не меняется', async () => {
    const p = seed();
    const bad: unknown[] = [
      { quantityVariants: [{ quantity: 0, unit: 'шт', price: 1 }] },
      { quantityVariants: [{ quantity: 1, unit: 'м', price: 1 }] },
      { quantityVariants: [{ quantity: 1, unit: 'шт', price: -5 }] },
      { quantityVariants: [{ quantity: 1, unit: 'шт', price: 1 }, { quantity: 1, unit: 'шт', price: 2 }] },
      { quantityVariants: Array.from({ length: 21 }, (_, i) => ({ quantity: i + 1, unit: 'шт', price: 1 })) },
      { details: ['javascript:alert(1)'] },
      { details: [''] },
      { details: [{ type: 'photo', url: 'https://a/1.jpg' }] },
      { details: ['https://a/1.jpg', 'https://a/1.jpg'] },
      { details: Array.from({ length: 11 }, (_, i) => `https://a/${i}.jpg`) },
      { details: 'строка' },
    ];
    for (const b of bad) {
      const r = await admin('PUT', `/api/products/${p.id}`, b);
      assert.equal(r.status, 400, JSON.stringify(b));
    }
    assert.equal(products[0].quantityVariants, null);
    assert.equal(products[0].details, null);
  });

  test('без админ-доступа PUT не работает', async () => {
    const p = seed();
    const r = await call('PUT', `/api/products/${p.id}`, { details: [] }, { 'x-app-key': APP_KEY });
    assert.equal(r.status, 401);
  });

  test('ровно 10 деталей проходят (максимум)', async () => {
    const p = seed();
    const details = Array.from({ length: 10 }, (_, i) => `https://a/${i}.jpg`);
    const r = await admin('PUT', `/api/products/${p.id}`, { details });
    assert.equal(r.status, 200);
    assert.equal(parseDetails(products[0].details).length, 10);
  });
});

describe('videos товара (до 3)', () => {
  const V = (n: number) => `https://blob.example.com/shop/video/${n}.mp4`;

  test('нет видео → videos: [] (в списке и в карточке), в том числе у старых строк без поля', async () => {
    const p = seed();
    delete p.videos;
    const list = await call('GET', '/api/shop/products');
    assert.deepEqual(list.json[0].videos, []);
    assert.deepEqual((await call('GET', `/api/shop/products/${p.shopArticle}`)).json.videos, []);
  });

  test('PUT сохраняет до 3 видео в порядке админки, публичный ответ их отдаёт', async () => {
    const p = seed();
    const put = await admin('PUT', `/api/products/${p.id}`, { videos: [V(2), V(1), V(3)] });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.deepEqual(products[0].videos, [V(2), V(1), V(3)]);
    assert.deepEqual((await call('GET', `/api/shop/products/${p.shopArticle}`)).json.videos, [V(2), V(1), V(3)]);
    assert.deepEqual((await call('GET', '/api/shop/products')).json[0].videos, [V(2), V(1), V(3)]);
  });

  test('убрать все → [], остальные поля товара не тронуты; PUT без videos видео не стирает', async () => {
    const p = seed({ videos: [V(1)], details: ['https://a/1.jpg'] });
    assert.equal((await admin('PUT', `/api/products/${p.id}`, { name: 'Другое имя' })).status, 200);
    assert.deepEqual(products[0].videos, [V(1)]);
    assert.equal((await admin('PUT', `/api/products/${p.id}`, { videos: [] })).status, 200);
    assert.deepEqual(products[0].videos, []);
    assert.deepEqual(products[0].details, ['https://a/1.jpg']);
    assert.deepEqual((await call('GET', `/api/shop/products/${p.shopArticle}`)).json.videos, []);
  });

  test('валидация: больше 3, не http(s), повтор → 400, в БД не меняется', async () => {
    const p = seed({ videos: [V(1)] });
    for (const videos of [[V(1), V(2), V(3), V(4)], ['javascript:alert(1)'], [V(1), V(1)], 'x']) {
      const r = await admin('PUT', `/api/products/${p.id}`, { videos });
      assert.equal(r.status, 400, JSON.stringify(videos));
    }
    assert.deepEqual(products[0].videos, [V(1)]);
  });

  test('POST создаёт товар с видео', async () => {
    const r = await admin('POST', '/api/products', { sku: 'vid-1', name: 'С видео', costPrice: 1, videos: [V(1), V(2)] });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json));
    assert.deepEqual(products[0].videos, [V(1), V(2)]);
  });

  test('мусор в БД не ломает ответ: нестроки и не-http отбрасываются, больше 3 обрезается', async () => {
    const p = seed({ videos: [V(1), 5, 'ftp://x', V(2), V(3), V(4)] });
    assert.deepEqual((await call('GET', `/api/shop/products/${p.shopArticle}`)).json.videos, [V(1), V(2), V(3)]);
  });
});
