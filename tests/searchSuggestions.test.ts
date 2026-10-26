/**
 * Подсказки поиска (GET /api/shop/search/suggestions) и запись поисковых
 * событий (POST /api/shop/events, fromSuggestion). БД — заглушка в памяти.
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
let events: Row[] = [];
let failDb = false;

const ci = (v: unknown, c: Row) => typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase());
function visible(p: Row, w: Row): boolean {
  if (w.shopActive !== undefined && p.shopActive !== w.shopActive) return false;
  if (w.shopArchived !== undefined && p.shopArchived !== w.shopArchived) return false;
  if (w.category?.not === null && p.category == null) return false;
  if (w.shopPrice?.not === null && p.shopPrice == null) return false;
  if (w.type?.not === null && p.type == null) return false;
  if (w.showcaseOnly !== undefined && !!p.showcaseOnly !== w.showcaseOnly) return false;
  return true;
}
const stub: Row = {
  product: {
    findMany: async (a: Row = {}) => {
      if (failDb) throw new Error('db down');
      const w = a.where ?? {};
      return products
        .filter((p) => visible(p, w) && (!w.OR || w.OR.some((o: Row) => Object.entries(o).some(([k, c]) => ci(p[k], c as Row)))))
        .slice(0, a.take ?? 1e9)
        .map((p) => ({ ...p }));
    },
  },
  shopEvent: {
    groupBy: async (a: Row) => {
      const w = a.where;
      const counts = new Map<string, number>();
      for (const e of events) {
        if (e.type !== w.type || !(e.resultsCount > w.resultsCount.gt) || e.createdAt < w.createdAt.gte) continue;
        if (!String(e.query).toLowerCase().startsWith(String(w.query.startsWith).toLowerCase())) continue;
        counts.set(e.query, (counts.get(e.query) ?? 0) + 1);
      }
      const min = a.having.query._count.gte;
      return [...counts.entries()].filter(([, n]) => n >= min).sort((x, y) => y[1] - x[1]).slice(0, a.take).map(([query, n]) => ({ query, _count: { query: n } }));
    },
    create: async (a: Row) => { events.push({ id: String(events.length + 1), ...a.data }); return a.data; },
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
const P = (name: string, category: string, type: string | null, over: Row = {}): Row =>
  ({ name, category, type, shopActive: true, shopArchived: false, showcaseOnly: false, shopPrice: 100, ...over });
const sugg = (q: string) => call('GET', `/api/shop/search/suggestions?q=${encodeURIComponent(q)}`);
const texts = (r: { json: any }) => r.json.suggestions.map((s: Row) => s.text);

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { products = []; events = []; failDb = false; });

describe('GET /api/shop/search/suggestions', () => {
  test('«косм»: категория, тип и названия товаров с типами в ответе', async () => {
    products = [
      P('Косметичка женская', 'Красота', 'Косметички'),
      P('Косметичка дорожная', 'Красота', 'Косметички'),
      P('Набор косметики', 'Косметика', 'Наборы'),
      P('Кружка', 'Дом', 'Кружки'),
    ];
    const r = await sugg('косм');
    assert.equal(r.status, 200);
    const byType = (t: string) => r.json.suggestions.filter((s: Row) => s.type === t).map((s: Row) => s.text);
    assert.deepEqual(byType('category'), ['Косметика']);
    assert.deepEqual(byType('type'), ['Косметички']);
    // с начала слова — раньше, при равенстве короче — выше
    assert.deepEqual(byType('product'), ['Косметичка женская', 'Косметичка дорожная', 'Набор косметики']);
    assert.ok(!texts(r).includes('Кружка'));
    assert.ok(r.json.suggestions.every((s: Row) => typeof s.text === 'string' && ['category', 'type', 'popular', 'product'].includes(s.type)));
  });

  test('порядок: категория → тип → популярные → товары; совпадение с начала слова выше', async () => {
    products = [P('Большая косметичка', 'Красота', 'Сумки'), P('Косметичка', 'Красота', 'Сумки')];
    events = [{ type: 'search', query: 'косметика корея', resultsCount: 5, createdAt: new Date() }, { type: 'search', query: 'косметика корея', resultsCount: 3, createdAt: new Date() }];
    const r = await sugg('косм');
    assert.deepEqual(r.json.suggestions, [
      { text: 'косметика корея', type: 'popular' },
      { text: 'Косметичка', type: 'product' },
      { text: 'Большая косметичка', type: 'product' },
    ]);
  });

  test('популярные: только успешные (resultsCount>0), повторившиеся ≥2 раза, за 90 дней, с началом на q', async () => {
    const now = new Date();
    const old = new Date(Date.now() - 100 * 86400_000);
    const ev = (query: string, resultsCount: number, createdAt = now) => ({ type: 'search', query, resultsCount, createdAt });
    events = [
      ev('косметика', 3), ev('косметика', 4),                 // ок
      ev('косметичка', 0), ev('косметичка', 0),               // «Ничего не нашли» — не годится
      ev('космос', 2),                                         // один раз — не показываем
      ev('косплей', 2, old), ev('косплей', 2, old),            // старше 90 дней
      ev('крем косметический', 2), ev('крем косметический', 2) // не начинается с q
    ];
    const r = await sugg('кос');
    assert.deepEqual(texts(r), ['косметика']);
  });

  test('товары не из витрины (выключены, в архиве, без цены/категории/типа) в подсказки не попадают', async () => {
    products = [
      P('Косметичка выкл', 'Красота', 'Т', { shopActive: false }),
      P('Косметичка архив', 'Красота', 'Т', { shopArchived: true }),
      P('Косметичка без цены', 'Красота', 'Т', { shopPrice: null }),
      P('Косметичка без категории', null as any, 'Т'),
      P('Косметичка без типа', 'Красота', null),
      P('Косметичка видимая', 'Красота', 'Т'),
    ];
    assert.deepEqual(texts(await sugg('косметичка')).filter((t: string) => t.startsWith('Косметичка')), ['Косметичка видимая']);
  });

  test('товары «только для витрины» в подсказки общего поиска не попадают', async () => {
    products = [P('Косметичка витринная', 'Красота', 'Сумки', { showcaseOnly: true }), P('Косметичка обычная', 'Красота', 'Сумки')];
    assert.deepEqual(texts(await sugg('косметичка')), ['Косметичка обычная']);
  });

  test('регистр не важен, пробелы схлопываются, дубли убираются, максимум 10', async () => {
    products = Array.from({ length: 30 }, (_, i) => P(`Чай номер ${i}`, 'Продукты', 'Чай'));
    products.push(P('чай номер 1', 'Продукты', 'Чай'));
    const r = await sugg('  ЧАЙ   НОМЕР ');
    assert.ok(r.json.suggestions.length <= 10);
    const low = texts(r).map((t: string) => t.toLowerCase());
    assert.equal(new Set(low).size, low.length);
  });

  test('слишком короткий/пустой/отсутствующий q → пустой список; длинный q обрезается', async () => {
    products = [P('Косметичка', 'Красота', 'Т')];
    for (const q of ['', ' ', 'к']) assert.deepEqual((await sugg(q)).json, { suggestions: [] });
    assert.deepEqual((await call('GET', '/api/shop/search/suggestions')).json, { suggestions: [] });
    assert.equal((await sugg('я'.repeat(500))).status, 200);
  });

  test('спецсимволы (%, _, кавычки, SQL) не ломают запрос', async () => {
    products = [P('Косметичка', 'Красота', 'Т')];
    for (const q of ["%%", "__", "' OR 1=1 --", '"; DROP TABLE x;', '\\']) assert.equal((await sugg(q)).status, 200);
  });

  test('сбой БД → 200 и пустой список, а не 500', async () => {
    failDb = true;
    const r = await sugg('косм');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { suggestions: [] });
  });

  test('без x-app-key подсказки закрыты', async () => {
    const r = await call('GET', `/api/shop/search/suggestions?q=${encodeURIComponent('косм')}`, undefined, {});
    assert.equal(r.status, 401);
  });
});

describe('POST /api/shop/events (search + fromSuggestion)', () => {
  test('сохраняет текст запроса, город, число результатов и признак подсказки; timestamp ставит БД', async () => {
    const r = await call('POST', '/api/shop/events', { type: 'search', query: ' косметичка ', city: 'Алматы', resultsCount: 7, fromSuggestion: true });
    assert.equal(r.status, 201);
    assert.deepEqual(
      { query: events[0].query, city: events[0].city, resultsCount: events[0].resultsCount, fromSuggestion: events[0].fromSuggestion, type: events[0].type },
      { query: 'косметичка', city: 'Алматы', resultsCount: 7, fromSuggestion: true, type: 'search' },
    );
  });

  test('старый формат без fromSuggestion работает как раньше (поле не пишется)', async () => {
    const r = await call('POST', '/api/shop/events', { type: 'search', query: 'чай', resultsCount: 0 });
    assert.equal(r.status, 201);
    assert.ok(!('fromSuggestion' in events[0]) || events[0].fromSuggestion === undefined);
  });

  test('fromSuggestion=false сохраняется; для не-search событий игнорируется', async () => {
    await call('POST', '/api/shop/events', { type: 'search', query: 'чай', fromSuggestion: false });
    assert.equal(events[0].fromSuggestion, false);
    await call('POST', '/api/shop/events', { type: 'view', sku: '123', fromSuggestion: true });
    assert.equal(events[1].fromSuggestion, undefined);
  });

  test('search без query → 400; fromSuggestion не boolean → 400', async () => {
    assert.equal((await call('POST', '/api/shop/events', { type: 'search', query: '  ', fromSuggestion: true })).status, 400);
    assert.equal((await call('POST', '/api/shop/events', { type: 'search', query: 'чай', fromSuggestion: 'yes' })).status, 400);
    assert.equal(events.length, 0);
  });
});
