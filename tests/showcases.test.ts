/**
 * Тесты подбаннерных витрин (src/routes/showcases.routes.ts — публичная часть,
 * src/routes/showcasesAdmin.routes.ts — управление) на настоящем Express-приложении.
 *
 * База данных НЕ используется: @prisma/client подменяется ЗАПОМИНАЮЩЕЙ заглушкой в
 * памяти (таблицы Product, Showcase*, уникальные индексы и каскадное удаление
 * воспроизведены так же, как в миграции). Внешние сервисы не вызываются.
 * Заглушка проверяет логику роутов, а не SQL: сами SQL-ограничения (уникальность,
 * каскад) отдельно проверялись на локальном PostgreSQL при подготовке миграции.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const ADMIN_USER = 'admin-test';
const ADMIN_PASSWORD = randomBytes(12).toString('hex'); // генерируется на лету, не печатается
const APP_KEY = randomBytes(8).toString('hex');

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = APP_KEY;
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

// ---------------------------------------------------------------------------
// Запоминающая заглушка Prisma
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
let seq = 0;
const newId = () => `id${++seq}`;
const tables: Record<string, Row[]> = {};
const reset = () => {
  for (const t of ['product', 'showcase', 'showcaseCollection', 'showcaseProduct', 'showcaseCollectionItem']) tables[t] = [];
};
reset();

function opMatch(val: any, cond: any): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return val === cond;
  if ('in' in cond && !cond.in.includes(val)) return false;
  if ('not' in cond) {
    if (cond.not === null ? val === null || val === undefined : val === cond.not) return false;
  }
  if ('contains' in cond) {
    const a = String(val ?? '');
    const b = String(cond.contains);
    if (cond.mode === 'insensitive' ? !a.toLowerCase().includes(b.toLowerCase()) : !a.includes(b)) return false;
  }
  if ('equals' in cond && val !== cond.equals) return false;
  return true;
}
function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w: Row) => matches(row, w));
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    return opMatch(row[k], cond);
  });
}
function sorted(rows: Row[], orderBy: any): Row[] {
  const list = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [f, dir] = Object.entries(o)[0] as [string, string];
      const x = a[f];
      const y = b[f];
      if (x === y) continue;
      const r = x > y ? 1 : -1;
      return dir === 'desc' ? -r : r;
    }
    return 0;
  });
}

const UNIQUE: Record<string, string[][]> = {
  product: [['sku']],
  showcaseProduct: [['showcaseId', 'productId']],
  showcaseCollectionItem: [['collectionId', 'productId']],
};
const CASCADE: Record<string, Array<{ child: string; fk: string }>> = {
  showcase: [
    { child: 'showcaseCollection', fk: 'showcaseId' },
    { child: 'showcaseProduct', fk: 'showcaseId' },
  ],
  showcaseCollection: [{ child: 'showcaseCollectionItem', fk: 'collectionId' }],
};

function model(name: string) {
  const t = () => tables[name];
  const withInclude = (row: Row | null, include?: Row) => {
    if (!row || !include) return row;
    const out: Row = { ...row };
    if (include.items) out.items = sorted(tables.showcaseCollectionItem.filter((i) => i.collectionId === row.id), include.items.orderBy);
    if (include._count) {
      out._count = {
        products: tables.showcaseProduct.filter((i) => i.showcaseId === row.id).length,
        collections: tables.showcaseCollection.filter((i) => i.showcaseId === row.id).length,
      };
    }
    return out;
  };
  const m = {
    findMany: async (a: Row = {}) => {
      let rows = sorted(t().filter((r) => matches(r, a.where)), a.orderBy);
      if (a.take) rows = rows.slice(0, a.take);
      return rows.map((r) => withInclude(r, a.include));
    },
    findFirst: async (a: Row = {}) => withInclude(sorted(t().filter((r) => matches(r, a.where)), a.orderBy)[0] ?? null, a.include),
    findUnique: async (a: Row) => withInclude(t().find((r) => matches(r, a.where)) ?? null, a.include),
    create: async (a: Row) => {
      const row: Row = { id: newId(), createdAt: new Date(++seq), updatedAt: new Date(seq), ...a.data };
      for (const cols of UNIQUE[name] ?? []) {
        if (t().some((r) => cols.every((c) => r[c] === row[c]))) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
      }
      t().push(row);
      return row;
    },
    update: async (a: Row) => {
      const row = t().find((r) => matches(r, a.where));
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, a.data, { updatedAt: new Date(++seq) });
      return row;
    },
    delete: async (a: Row) => {
      const i = t().findIndex((r) => matches(r, a.where));
      if (i < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      const [row] = t().splice(i, 1);
      for (const c of CASCADE[name] ?? []) {
        const doomed = tables[c.child].filter((r) => r[c.fk] === row.id);
        for (const d of doomed) await (stub as any)[c.child].delete({ where: { id: d.id } });
      }
      return row;
    },
    count: async (a: Row = {}) => t().filter((r) => matches(r, a.where)).length,
    groupBy: async () => [],
  };
  return m;
}
const stub: Record<string, any> = {};
for (const n of Object.keys(tables)) stub[n] = model(n);
stub.shopReview = { groupBy: async () => [], findMany: async () => [] };
stub.$transaction = async (ops: Promise<any>[]) => Promise.all(ops);

class StubPrismaClient {
  constructor() {
    return new Proxy(this, {
      get: (_t, key) => {
        if (key === 'then') return undefined;
        if (key in stub) return stub[key as string];
        // Любая другая таблица ведёт себя как пустая (приложение трогает их только при старте).
        return new Proxy({}, { get: (_m, method) => async () => (/^find(First|Unique)/.test(String(method)) ? null : String(method) === 'count' ? 0 : []) });
      },
    });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------
interface Res { status: number; json: any; text: string }
let port = 0;
let server: http.Server;

function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h: Record<string, string> = { ...headers };
    if (payload !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = String(Buffer.byteLength(payload)); }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* не JSON */ }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}
const AUTH = { authorization: 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64') };
const KEY = { 'x-app-key': APP_KEY };
const adm = (m: string, p: string, b?: unknown) => call(m, `/api/shop-admin/showcases${p}`, AUTH, b);
const pub = (p: string) => call('GET', `/api/shop/showcases${p}`, KEY);

function seedProduct(over: Row = {}): Row {
  const id = over.id ?? newId();
  const row: Row = {
    id, sku: `sku-${id}`, name: `Товар ${id}`, category: 'Обувь', subcategory: null, type: 'Кроссовки',
    shopActive: true, shopArchived: false, shopPrice: 1000, shopOldPrice: null, shopStock: 5, shopArticle: `A${id}`,
    images: JSON.stringify([`https://img.example/${id}.jpg`]), description: null, descriptionSource: null,
    composition: null, characteristics: null, ozonType: null, variantGroup: null, variantLabel: null,
    shopVideo: null, videoUrl: null, shopDelivery: null, banner: null, bannerTitle: null, bannerSubtitle: null,
    createdAt: new Date(++seq), updatedAt: new Date(seq), ...over,
  };
  tables.product.push(row);
  return row;
}
const names = (r: Res) => (r.json as any[]).map((p) => p.name);

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => reset());

async function newShowcase(over: Row = {}): Promise<Row> {
  const r = await adm('POST', '', { type: 'brand', title: 'Nike', ...over });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

// ---------------------------------------------------------------------------
describe('создание и редактирование витрины', () => {
  test('создание: поля сохраняются, новая витрина по умолчанию скрыта, порядок растёт', async () => {
    const a = await newShowcase({ title: 'Nike', description: 'Спорт', bannerText: 'Скидки', bannerTitle: 'Лето' });
    const b = await newShowcase({ type: 'shop', title: 'Dyson Store' });
    assert.equal(a.published, false);
    assert.equal(a.type, 'brand');
    assert.equal(a.description, 'Спорт');
    assert.equal(a.bannerTitle, 'Лето');
    assert.equal(b.type, 'shop');
    assert.ok(b.sortOrder > a.sortOrder);
    assert.ok(a.id && a.id !== b.id, 'у каждой витрины свой уникальный id');
  });

  test('проверка входных данных: пустое название, неверный тип, не-http ссылка на картинку → 400', async () => {
    assert.equal((await adm('POST', '', { type: 'brand', title: '   ' })).status, 400);
    assert.equal((await adm('POST', '', { type: 'other', title: 'X' })).status, 400);
    assert.equal((await adm('POST', '', { type: 'brand', title: 'X', logoUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await adm('POST', '', { type: 'brand', title: 'X', bannerUrl: 'file:///etc/passwd' })).status, 400);
    assert.equal(tables.showcase.length, 0, 'ничего не создано');
  });

  test('редактирование: название, описание, тип; пустая строка очищает необязательное поле', async () => {
    const s = await newShowcase({ description: 'старое' });
    const r = await adm('PATCH', `/${s.id}`, { title: 'Nike Official', description: '', type: 'shop' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.title, 'Nike Official');
    assert.equal(r.json.description, null);
    assert.equal(r.json.type, 'shop');
    assert.equal((await adm('PATCH', '/nope', { title: 'x' })).status, 404);
    assert.equal((await adm('PATCH', `/${s.id}`, { title: '' })).status, 400);
  });

  test('поиск по названию (без учёта регистра)', async () => {
    await newShowcase({ title: 'Nike' });
    await newShowcase({ title: 'Adidas' });
    await newShowcase({ title: 'Dyson' });
    const r = await adm('GET', '?q=nIK');
    assert.deepEqual(r.json.map((s: Row) => s.title), ['Nike']);
    assert.equal((await adm('GET', '')).json.length, 3);
  });
});

// ---------------------------------------------------------------------------
describe('изображение и порядок', () => {
  test('логотип и баннер заменяются и очищаются', async () => {
    const s = await newShowcase();
    let r = await adm('PATCH', `/${s.id}`, { logoUrl: 'https://blob.example/logo1.png', bannerUrl: 'https://blob.example/b1.jpg' });
    assert.equal(r.json.logoUrl, 'https://blob.example/logo1.png');
    r = await adm('PATCH', `/${s.id}`, { logoUrl: 'https://blob.example/logo2.png' });
    assert.equal(r.json.logoUrl, 'https://blob.example/logo2.png');
    assert.equal(r.json.bannerUrl, 'https://blob.example/b1.jpg', 'не тронутое поле не меняется');
    r = await adm('PATCH', `/${s.id}`, { bannerUrl: null });
    assert.equal(r.json.bannerUrl, null);
  });

  test('порядок витрин меняется, приложение видит новый порядок', async () => {
    const a = await newShowcase({ title: 'A', published: true });
    const b = await newShowcase({ title: 'B', published: true });
    const c = await newShowcase({ title: 'C', published: true });
    assert.deepEqual((await pub('')).json.map((s: Row) => s.title), ['A', 'B', 'C']);
    assert.equal((await adm('PUT', '/order', { ids: [c.id, a.id, b.id] })).status, 200);
    assert.deepEqual((await pub('')).json.map((s: Row) => s.title), ['C', 'A', 'B']);
    assert.deepEqual((await adm('GET', '')).json.map((s: Row) => s.title), ['C', 'A', 'B']);
  });

  test('порядок: повторы и неизвестные id отклоняются без изменений', async () => {
    const a = await newShowcase({ title: 'A' });
    const b = await newShowcase({ title: 'B' });
    assert.equal((await adm('PUT', '/order', { ids: [a.id, a.id] })).status, 400);
    assert.equal((await adm('PUT', '/order', { ids: [a.id, 'nope'] })).status, 400);
    assert.deepEqual((await adm('GET', '')).json.map((s: Row) => s.title), ['A', 'B']);
    void b;
  });
});

// ---------------------------------------------------------------------------
describe('публикация и скрытие', () => {
  test('скрытая витрина не видна приложению (список, страница, товары); после публикации видна', async () => {
    const p = seedProduct({ name: 'Кроссовки Air' });
    const s = await newShowcase({ title: 'Nike' });
    await adm('POST', `/${s.id}/products`, { productId: p.id });
    assert.deepEqual((await pub('')).json, []);
    assert.equal((await pub(`/${s.id}`)).status, 404);
    assert.equal((await pub(`/${s.id}/products`)).status, 404);

    await adm('PATCH', `/${s.id}`, { published: true });
    assert.equal((await pub('')).json.length, 1);
    assert.equal((await pub(`/${s.id}`)).status, 200);
    assert.deepEqual(names(await pub(`/${s.id}/products`)), ['Кроссовки Air']);

    await adm('PATCH', `/${s.id}`, { published: false });
    assert.deepEqual((await pub('')).json, []);
    assert.equal((await pub(`/${s.id}`)).status, 404);
    assert.equal(tables.showcaseProduct.length, 1, 'привязки сохранились при скрытии');
  });
});

// ---------------------------------------------------------------------------
describe('товары витрины', () => {
  test('добавление, поиск по названию и ID, удаление; товар остаётся в каталоге', async () => {
    const p1 = seedProduct({ name: 'Кроссовки Air Max' });
    const p2 = seedProduct({ name: 'Футболка' });
    const s = await newShowcase();
    assert.equal((await adm('POST', `/${s.id}/products`, { productId: p1.id })).status, 201);
    assert.equal((await adm('POST', `/${s.id}/products`, { productId: p2.id })).status, 201);

    const byName = await adm('GET', '/product-search?q=air');
    assert.deepEqual(byName.json.map((p: Row) => p.id), [p1.id]);
    const byId = await adm('GET', `/product-search?q=${p2.id}`);
    assert.deepEqual(byId.json.map((p: Row) => p.id), [p2.id]);

    const full = await adm('GET', `/${s.id}`);
    assert.deepEqual(full.json.products.map((p: Row) => p.id), [p1.id, p2.id]);

    assert.equal((await adm('DELETE', `/${s.id}/products/${p1.id}`)).status, 200);
    assert.deepEqual((await adm('GET', `/${s.id}`)).json.products.map((p: Row) => p.id), [p2.id]);
    assert.ok(tables.product.some((p) => p.id === p1.id), 'товар не удалён из каталога');
    assert.equal((await adm('DELETE', `/${s.id}/products/${p1.id}`)).status, 404, 'повторное удаление привязки');
  });

  test('дубли внутри витрины запрещены (409), в базе одна связь', async () => {
    const p = seedProduct();
    const s = await newShowcase();
    assert.equal((await adm('POST', `/${s.id}/products`, { productId: p.id })).status, 201);
    const dup = await adm('POST', `/${s.id}/products`, { productId: p.id });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.code, 'DUPLICATE');
    assert.equal(tables.showcaseProduct.length, 1);
  });

  test('дубль, прошедший проверку (гонка запросов), останавливает уникальный индекс → 409', async () => {
    const p = seedProduct();
    const s = await newShowcase();
    const [x, y] = await Promise.all([
      adm('POST', `/${s.id}/products`, { productId: p.id }),
      adm('POST', `/${s.id}/products`, { productId: p.id }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [201, 409]);
    assert.equal(tables.showcaseProduct.length, 1);
  });

  test('несуществующий товар и несуществующая витрина → 404, ничего не создаётся', async () => {
    const s = await newShowcase();
    assert.equal((await adm('POST', `/${s.id}/products`, { productId: 'ghost' })).status, 404);
    const p = seedProduct();
    assert.equal((await adm('POST', '/ghost/products', { productId: p.id })).status, 404);
    assert.equal(tables.showcaseProduct.length, 0);
  });

  test('один товар в нескольких витринах без копий', async () => {
    const p = seedProduct({ name: 'Универсальный' });
    const nike = await newShowcase({ title: 'Nike', published: true });
    const adidas = await newShowcase({ title: 'Adidas', published: true });
    await adm('POST', `/${nike.id}/products`, { productId: p.id });
    await adm('POST', `/${adidas.id}/products`, { productId: p.id });
    assert.equal(tables.product.length, 1, 'копий товара нет');
    assert.equal(tables.showcaseProduct.length, 2);
    assert.deepEqual(names(await pub(`/${nike.id}/products`)), ['Универсальный']);
    assert.deepEqual(names(await pub(`/${adidas.id}/products`)), ['Универсальный']);
  });

  test('порядок товаров в витрине меняется и отражается в приложении', async () => {
    const [a, b, c] = ['A', 'B', 'C'].map((n) => seedProduct({ name: n }));
    const s = await newShowcase({ published: true });
    for (const p of [a, b, c]) await adm('POST', `/${s.id}/products`, { productId: p.id });
    assert.deepEqual(names(await pub(`/${s.id}/products`)), ['A', 'B', 'C']);
    assert.equal((await adm('PUT', `/${s.id}/products/order`, { productIds: [c.id, a.id, b.id] })).status, 200);
    assert.deepEqual(names(await pub(`/${s.id}/products`)), ['C', 'A', 'B']);
    assert.equal((await adm('PUT', `/${s.id}/products/order`, { productIds: [a.id, a.id] })).status, 400);
    assert.equal((await adm('PUT', `/${s.id}/products/order`, { productIds: [a.id, 'ghost'] })).status, 400);
    assert.deepEqual(names(await pub(`/${s.id}/products`)), ['C', 'A', 'B'], 'неверный запрос порядок не ломает');
  });
});

// ---------------------------------------------------------------------------
describe('выдача правильных товаров', () => {
  test('в витрине бренда только привязанные товары, совпадение названия ничего не значит', async () => {
    const nikeShoe = seedProduct({ name: 'Nike Air' });
    const nikeLookalike = seedProduct({ name: 'Nike Air (чужой)' }); // «Nike» в названии, но не привязан
    const adidasShoe = seedProduct({ name: 'Adidas Samba' });
    const nike = await newShowcase({ title: 'Nike', published: true });
    const adidas = await newShowcase({ title: 'Adidas', published: true });
    await adm('POST', `/${nike.id}/products`, { productId: nikeShoe.id });
    await adm('POST', `/${adidas.id}/products`, { productId: adidasShoe.id });

    assert.deepEqual(names(await pub(`/${nike.id}/products`)), ['Nike Air']);
    assert.deepEqual(names(await pub(`/${adidas.id}/products`)), ['Adidas Samba']);
    void nikeLookalike;
  });

  test('товар, скрытый в каталоге, архивный или без цены, покупателю не виден, но привязка не теряется', async () => {
    const ok = seedProduct({ name: 'Виден' });
    const hidden = seedProduct({ name: 'Скрыт', shopActive: false });
    const archived = seedProduct({ name: 'Архив', shopArchived: true });
    const noPrice = seedProduct({ name: 'БезЦены', shopPrice: null });
    const s = await newShowcase({ published: true });
    for (const p of [ok, hidden, archived, noPrice]) await adm('POST', `/${s.id}/products`, { productId: p.id });
    assert.deepEqual(names(await pub(`/${s.id}/products`)), ['Виден']);
    assert.equal(tables.showcaseProduct.length, 4);
    hidden.shopActive = true; // вернули в продажу
    assert.deepEqual(names(await pub(`/${s.id}/products`)), ['Виден', 'Скрыт']);
  });

  test('формат товара совпадает с общим каталогом (sku = артикул витрины, поля цены и картинок)', async () => {
    const p = seedProduct({ name: 'Формат', shopPrice: 4990, shopArticle: '1234567' });
    const s = await newShowcase({ published: true });
    await adm('POST', `/${s.id}/products`, { productId: p.id });
    const item = (await pub(`/${s.id}/products`)).json[0];
    assert.equal(item.sku, '1234567');
    assert.equal(item.price, 4990);
    assert.deepEqual(item.images, [`https://img.example/${p.id}.jpg`]);
    assert.equal('id' in item, false, 'внутренний id товара наружу не уходит (как и в /api/shop/products)');
  });

  test('поиск и сортировка внутри витрины', async () => {
    const a = seedProduct({ name: 'Бег', shopPrice: 300 });
    const b = seedProduct({ name: 'Ходьба', shopPrice: 100 });
    const c = seedProduct({ name: 'Бегемот', shopPrice: 200 });
    const s = await newShowcase({ published: true });
    for (const p of [a, b, c]) await adm('POST', `/${s.id}/products`, { productId: p.id });
    assert.deepEqual(names(await pub(`/${s.id}/products?q=${encodeURIComponent("бег")}`)), ['Бег', 'Бегемот']);
    assert.deepEqual(names(await pub(`/${s.id}/products?sort=price_asc`)), ['Ходьба', 'Бегемот', 'Бег']);
    assert.deepEqual(names(await pub(`/${s.id}/products?sort=price_desc`)), ['Бег', 'Бегемот', 'Ходьба']);
  });
});

// ---------------------------------------------------------------------------
describe('рекламные подборки', () => {
  test('создание, товары, порядок, скрытие и удаление; страница витрины показывает только опубликованные непустые подборки', async () => {
    const [a, b] = [seedProduct({ name: 'A' }), seedProduct({ name: 'B' })];
    const s = await newShowcase({ published: true });
    const col1 = (await adm('POST', `/${s.id}/collections`, { title: 'Новинки' })).json;
    const col2 = (await adm('POST', `/${s.id}/collections`, { title: 'Хиты продаж' })).json;
    const empty = (await adm('POST', `/${s.id}/collections`, { title: 'Пустая' })).json;
    for (const p of [a, b]) await adm('POST', `/${s.id}/collections/${col1.id}/items`, { productId: p.id });
    await adm('POST', `/${s.id}/collections/${col2.id}/items`, { productId: b.id });
    void empty;

    let page = (await pub(`/${s.id}`)).json;
    assert.deepEqual(page.collections.map((c: Row) => c.title), ['Новинки', 'Хиты продаж']);
    assert.deepEqual(page.collections[0].products.map((p: Row) => p.name), ['A', 'B']);

    // дубль в подборке
    assert.equal((await adm('POST', `/${s.id}/collections/${col1.id}/items`, { productId: a.id })).status, 409);
    // порядок подборок и товаров
    await adm('PUT', `/${s.id}/collections/order`, { ids: [col2.id, col1.id, empty.id] });
    await adm('PUT', `/${s.id}/collections/${col1.id}/items/order`, { productIds: [b.id, a.id] });
    page = (await pub(`/${s.id}`)).json;
    assert.deepEqual(page.collections.map((c: Row) => c.title), ['Хиты продаж', 'Новинки']);
    assert.deepEqual(page.collections[1].products.map((p: Row) => p.name), ['B', 'A']);

    // скрытая подборка не видна
    await adm('PATCH', `/${s.id}/collections/${col2.id}`, { published: false });
    assert.deepEqual((await pub(`/${s.id}`)).json.collections.map((c: Row) => c.title), ['Новинки']);

    // убрать товар из подборки — он остаётся и в каталоге, и в витрине
    await adm('POST', `/${s.id}/products`, { productId: a.id });
    assert.equal((await adm('DELETE', `/${s.id}/collections/${col1.id}/items/${a.id}`)).status, 200);
    assert.ok(tables.product.some((p) => p.id === a.id));
    assert.equal(tables.showcaseProduct.length, 1);

    // удалить подборку — товары остаются
    assert.equal((await adm('DELETE', `/${s.id}/collections/${col1.id}`)).status, 200);
    assert.equal(tables.product.length, 2);
    assert.equal(tables.showcaseCollectionItem.filter((i) => i.collectionId === col1.id).length, 0);
  });

  test('страница витрины грузит товары одним запросом, сколько бы ни было подборок; один товар в двух подборках', async () => {
    const [a, b, c] = ['A', 'B', 'C'].map((n) => seedProduct({ name: n }));
    const s = await newShowcase({ published: true });
    const cols: Row[] = [];
    for (const title of ['К1', 'К2', 'К3']) cols.push((await adm('POST', `/${s.id}/collections`, { title })).json);
    await adm('POST', `/${s.id}/collections/${cols[0].id}/items`, { productId: a.id });
    await adm('POST', `/${s.id}/collections/${cols[0].id}/items`, { productId: b.id });
    await adm('POST', `/${s.id}/collections/${cols[1].id}/items`, { productId: b.id });
    await adm('POST', `/${s.id}/collections/${cols[2].id}/items`, { productId: c.id });
    const orig = stub.product.findMany;
    let productQueries = 0;
    stub.product.findMany = async (...args: any[]) => { productQueries++; return orig(...args); };
    try {
      const page = (await pub(`/${s.id}`)).json;
      assert.deepEqual(page.collections.map((x: Row) => x.products.map((p: Row) => p.name)), [['A', 'B'], ['B'], ['C']]);
      assert.equal(productQueries, 1, 'запросов к товарам: ' + productQueries);
    } finally {
      stub.product.findMany = orig;
    }
  });

  test('подборку нельзя тронуть через чужую витрину', async () => {
    const s1 = await newShowcase({ title: 'S1' });
    const s2 = await newShowcase({ title: 'S2' });
    const col = (await adm('POST', `/${s1.id}/collections`, { title: 'К' })).json;
    assert.equal((await adm('PATCH', `/${s2.id}/collections/${col.id}`, { title: 'x' })).status, 404);
    assert.equal((await adm('DELETE', `/${s2.id}/collections/${col.id}`)).status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('удаление витрины', () => {
  test('без подтверждения не удаляет; с подтверждением удаляет витрину, подборки и привязки, но НЕ товары', async () => {
    const p1 = seedProduct({ name: 'P1' });
    const p2 = seedProduct({ name: 'P2' });
    const nike = await newShowcase({ title: 'Nike', published: true });
    const adidas = await newShowcase({ title: 'Adidas', published: true });
    const col = (await adm('POST', `/${nike.id}/collections`, { title: 'Новинки' })).json;
    await adm('POST', `/${nike.id}/products`, { productId: p1.id });
    await adm('POST', `/${nike.id}/products`, { productId: p2.id });
    await adm('POST', `/${nike.id}/collections/${col.id}/items`, { productId: p1.id });
    await adm('POST', `/${adidas.id}/products`, { productId: p1.id });
    const productsBefore = JSON.stringify(tables.product);

    const noConfirm = await adm('DELETE', `/${nike.id}`);
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.json.code, 'CONFIRM_REQUIRED');
    assert.equal(tables.showcase.length, 2, 'без подтверждения ничего не удалено');

    assert.equal((await adm('DELETE', `/${nike.id}?confirm=1`)).status, 200);
    assert.equal(tables.showcase.length, 1);
    assert.equal(tables.showcaseCollection.length, 0);
    assert.equal(tables.showcaseCollectionItem.length, 0);
    assert.deepEqual(tables.showcaseProduct.map((l) => l.showcaseId), [adidas.id], 'связи другой витрины целы');
    assert.equal(JSON.stringify(tables.product), productsBefore, 'каталог товаров не изменился ни на байт');
    assert.deepEqual(names(await pub(`/${adidas.id}/products`)), ['P1']);
    assert.equal((await adm('DELETE', `/${nike.id}?confirm=1`)).status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('доступ и публичный API', () => {
  const ADMIN_CALLS: Array<[string, string, unknown?]> = [
    ['GET', ''],
    ['POST', '', { type: 'brand', title: 'X' }],
    ['PUT', '/order', { ids: [] }],
    ['GET', '/product-search?q=a'],
    ['GET', '/s1'],
    ['PATCH', '/s1', { title: 'x' }],
    ['DELETE', '/s1?confirm=1'],
    ['POST', '/s1/products', { productId: 'p' }],
    ['PUT', '/s1/products/order', { productIds: [] }],
    ['DELETE', '/s1/products/p'],
    ['POST', '/s1/collections', { title: 'x' }],
    ['PUT', '/s1/collections/order', { ids: [] }],
    ['PATCH', '/s1/collections/c1', { title: 'x' }],
    ['DELETE', '/s1/collections/c1'],
    ['POST', '/s1/collections/c1/items', { productId: 'p' }],
    ['PUT', '/s1/collections/c1/items/order', { productIds: [] }],
    ['DELETE', '/s1/collections/c1/items/p'],
  ];

  test('все административные маршруты без входа → 401 и база не меняется', async () => {
    const p = seedProduct();
    const s = await newShowcase();
    await adm('POST', `/${s.id}/products`, { productId: p.id });
    const before = JSON.stringify(tables);
    for (const [m, path, body] of ADMIN_CALLS) {
      const r = await call(m, `/api/shop-admin/showcases${path}`, {}, body);
      assert.equal(r.status, 401, `${m} ${path}`);
      assert.equal(r.json?.code, 'ADMIN_AUTH_REQUIRED', `${m} ${path}`);
    }
    assert.equal(JSON.stringify(tables), before);
  });

  test('ключ приложения x-app-key НЕ даёт доступа к административным маршрутам', async () => {
    const before = JSON.stringify(tables);
    for (const [m, path, body] of ADMIN_CALLS) {
      const r = await call(m, `/api/shop-admin/showcases${path}`, KEY, body);
      assert.equal(r.status, 401, `${m} ${path}`);
    }
    assert.equal(JSON.stringify(tables), before);
  });

  test('неверный пароль и вариации адреса (регистр, двойной слэш, %-кодирование) тоже закрыты', async () => {
    const bad = { authorization: 'Basic ' + Buffer.from(`${ADMIN_USER}:wrong-password-123`).toString('base64') };
    for (const p of ['/api/shop-admin/showcases', '/API/SHOP-ADMIN/SHOWCASES', '/api//shop-admin/showcases', '/api/shop-admin/%73howcases', '/api/shop-admin/showcases/']) {
      assert.equal((await call('GET', p, bad)).status, 401, p);
      assert.equal((await call('GET', p, {})).status, 401, p);
    }
  });

  test('ADMIN_USER / ADMIN_PASSWORD не заданы → 503, открытого режима нет', async () => {
    const saved = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    try {
      const r = await call('GET', '/api/shop-admin/showcases', AUTH);
      assert.equal(r.status, 503);
      assert.equal(r.json.code, 'ADMIN_AUTH_NOT_CONFIGURED');
    } finally {
      process.env.ADMIN_PASSWORD = saved;
    }
  });

  test('изменяющий запрос с другого сайта блокируется (CSRF), даже с верным входом', async () => {
    const r = await call('POST', '/api/shop-admin/showcases', { ...AUTH, 'sec-fetch-site': 'cross-site' }, { type: 'brand', title: 'Evil' });
    assert.equal(r.status, 403);
    assert.equal(tables.showcase.length, 0);
  });

  test('публичный API требует x-app-key', async () => {
    const s = await newShowcase({ published: true });
    for (const p of ['', `/${s.id}`, `/${s.id}/products`]) {
      assert.equal((await call('GET', `/api/shop/showcases${p}`, {})).status, 401, p);
      assert.equal((await call('GET', `/api/shop/showcases${p}`, { 'x-app-key': 'wrong' })).status, 401, p);
    }
  });

  test('публичный API только читает: изменяющие методы не создают и не меняют данные', async () => {
    const s = await newShowcase({ published: true });
    const before = JSON.stringify(tables);
    for (const [m, p] of [['POST', ''], ['PATCH', `/${s.id}`], ['PUT', `/${s.id}`], ['DELETE', `/${s.id}`], ['POST', `/${s.id}/products`]] as const) {
      const r = await call(m, `/api/shop/showcases${p}`, KEY, {});
      assert.ok([404, 405].includes(r.status), `${m} ${p} → ${r.status}`);
    }
    assert.equal(JSON.stringify(tables), before);
  });

  test('публичный ответ не раскрывает административные данные', async () => {
    const p = seedProduct();
    const s = await newShowcase({ published: true, title: 'Nike', bannerText: 'Реклама' });
    await adm('POST', `/${s.id}/products`, { productId: p.id });
    await adm('POST', `/${s.id}/collections`, { title: 'К' });
    const list = (await pub('')).json[0];
    const detail = (await pub(`/${s.id}`)).json;
    const leak = ['published', 'sortOrder', 'createdAt', 'updatedAt', '_count', 'products'];
    for (const k of leak) {
      assert.equal(k in list, false, `список: ${k}`);
      if (k !== 'products') assert.equal(k in detail, false, `страница: ${k}`);
    }
    assert.deepEqual(Object.keys(list).sort(), ['bannerText', 'bannerTitle', 'bannerUrl', 'description', 'id', 'logoUrl', 'title', 'type']);
    assert.equal(list.title, 'Nike');
    assert.equal(JSON.stringify(detail).includes(p.id), false, 'внутренний id товара не публикуется');
  });
});
