/**
 * Напоминание о корзине: пуш через 24 часа владельцу корзины. БД, Expo и Firebase — заглушки.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';

type Row = Record<string, any>;
const NOW = new Date('2026-10-28T12:00:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);
let events: Row[] = [];
let orders: Row[] = [];
let products: Row[] = [];
let tokens: Row[] = [];
let reminders: Row[] = [];
let idn = 0;
const match = (v: any, c: any): boolean => {
  if (c && typeof c === 'object' && !(c instanceof Date)) {
    if ('gte' in c && !(new Date(v) >= c.gte)) return false;
    if ('in' in c && !c.in.includes(v)) return false;
    if ('not' in c && v === c.not) return false;
    return true;
  }
  return v === c;
};
const filt = (rows: Row[], where: Row = {}) => rows.filter((r) => Object.entries(where).every(([k, c]) => (k === 'OR' ? (c as Row[]).some((w) => Object.entries(w).every(([kk, cc]) => match(r[kk], cc))) : match(r[k], c))));
const stub: Row = {
  shopEvent: { findMany: async (a: Row) => filt(events, a.where).sort((x, y) => +y.createdAt - +x.createdAt) },
  shopOrder: { findMany: async (a: Row) => filt(orders, a.where) },
  product: { findMany: async (a: Row) => filt(products, a.where).slice(0, a.take ?? 99) },
  shopCustomerPushToken: { findUnique: async (a: Row) => tokens.find((t) => t.phone === a.where.phone) ?? null },
  cartReminder: {
    findMany: async (a: Row) => filt(reminders, a.where),
    create: async (a: Row) => {
      if (reminders.some((r) => r.eventId === a.data.eventId)) throw new Error('unique');
      const row = { id: `r${++idn}`, sentAt: new Date(), ...a.data };
      reminders.push(row);
      return row;
    },
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
const { runCartReminders, discountPercent, reminderText } = require('../src/services/cartReminder.service');

let expoCalls: Row[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).startsWith('https://exp.host/')) {
    const msgs: Row[] = JSON.parse(init.body);
    expoCalls.push(...msgs);
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok' })) }), { status: 200 });
  }
  return realFetch(url, init);
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const PHONE = '77011112233';
const base = () => {
  events = [{ id: 'e1', type: 'cart', sku: 'SKU-1', phone: '8 701 111 22 33', createdAt: ago(30) }];
  products = [{ id: 'p1', sku: 'SKU-1', shopArticle: '1000001', name: 'Крем для лица', shopActive: true, shopArchived: false, shopPrice: 18900, shopOldPrice: 24900, shopStock: 5, images: JSON.stringify(['https://img.example/a.jpg', 'https://img.example/b.jpg']) }];
  tokens = [{ phone: PHONE, token: 'ExponentPushToken[abc]' }];
  orders = []; reminders = []; expoCalls = [];
};
beforeEach(base);

describe('скидка и текст', () => {
  test('процент из старой цены; нет скидки — null', () => {
    assert.equal(discountPercent(18900, 24900), 24);
    assert.equal(discountPercent(50, 100), 50);
    assert.equal(discountPercent(100, null), null);
    assert.equal(discountPercent(100, 100), null);
    assert.equal(discountPercent(100, 90), null);
  });
  test('текст по шаблону; длинное название обрезается; без скидки — без «Скидка»', () => {
    assert.equal(reminderText('Крем', 24), 'Вы оставили Крем. Скидка 24% — успейте купить');
    assert.equal(reminderText('Крем', null), 'Вы оставили Крем. Успейте купить');
    assert.ok(reminderText('А'.repeat(100), 10).length < 100);
  });
});

describe('runCartReminders', () => {
  test('корзина старше 24 ч, заказа нет → пуш владельцу: текст, картинка, открытие товара', async () => {
    const r = await runCartReminders(NOW);
    assert.deepEqual([r.candidates, r.sent, r.skipped, r.failed], [1, 1, 0, 0]);
    assert.equal(expoCalls.length, 1);
    const m = expoCalls[0];
    assert.equal(m.to, 'ExponentPushToken[abc]');
    assert.equal(m.body, 'Вы оставили Крем для лица. Скидка 24% — успейте купить');
    assert.deepEqual(m.richContent, { image: 'https://img.example/a.jpg' });
    assert.equal(m.data.type, 'cart_reminder');
    assert.equal(m.data.screen, 'product');
    assert.equal(m.data.productId, 'p1');
    assert.equal(m.data.sku, 'SKU-1');
    assert.equal(m.data.shopArticle, '1000001');
    assert.equal(reminders.length, 1);
  });

  test('повторный запуск не шлёт то же напоминание второй раз', async () => {
    await runCartReminders(NOW);
    const r = await runCartReminders(NOW);
    assert.equal(r.sent, 0);
    assert.equal(expoCalls.length, 1);
  });

  test('корзина младше 24 ч → ждём', async () => {
    events[0].createdAt = ago(10);
    assert.equal((await runCartReminders(NOW)).candidates, 0);
    assert.equal(expoCalls.length, 0);
  });

  test('корзина старше 48 ч → не трогаем (окно)', async () => {
    events[0].createdAt = ago(60);
    assert.equal((await runCartReminders(NOW)).candidates, 0);
  });

  test('после корзины оформлен заказ (или оплата) → не шлём; отменённый заказ не считается', async () => {
    orders = [{ id: 'o1', phone: '87011112233', status: 'pending_payment', createdAt: ago(20) }];
    assert.equal((await runCartReminders(NOW)).sent, 0);
    orders = [{ id: 'o1', phone: '87011112233', status: 'cancelled', createdAt: ago(20) }];
    assert.equal((await runCartReminders(NOW)).sent, 1);
    reminders = []; expoCalls = [];
    orders = [];
    events.push({ id: 'e2', type: 'paid', phone: PHONE, createdAt: ago(5) });
    assert.equal((await runCartReminders(NOW)).sent, 0);
  });

  test('заказ ДО корзины не мешает', async () => {
    orders = [{ id: 'o0', phone: PHONE, status: 'delivered', createdAt: ago(40) }];
    assert.equal((await runCartReminders(NOW)).sent, 1);
  });

  test('есть более свежее событие корзины (<24 ч) → человек активен, не шлём', async () => {
    events.push({ id: 'e3', type: 'cart', sku: 'SKU-2', phone: PHONE, createdAt: ago(2) });
    const r = await runCartReminders(NOW);
    assert.equal(r.sent, 0);
    assert.equal(expoCalls.length, 0);
  });

  test('несколько товаров в корзине → один пуш на номер, про последний', async () => {
    products.push({ id: 'p2', sku: 'SKU-2', shopArticle: '1000002', name: 'Шампунь', shopActive: true, shopPrice: 1000, shopOldPrice: null, shopStock: 3, images: null });
    events.push({ id: 'e4', type: 'cart', sku: 'SKU-2', phone: PHONE, createdAt: ago(26) });
    const r = await runCartReminders(NOW);
    assert.equal(r.sent, 1);
    assert.equal(expoCalls[0].body, 'Вы оставили Шампунь. Успейте купить');
    assert.equal(expoCalls[0].richContent, undefined); // нет фото — пуш без картинки
  });

  test('номеру уже слали напоминание за последние 24 ч → не шлём', async () => {
    reminders = [{ id: 'old', eventId: 'e0', phone: PHONE, sku: 'X', sentAt: ago(5) }];
    assert.equal((await runCartReminders(NOW)).sent, 0);
  });

  test('нет токена, гостевое событие без телефона, товар скрыт/нет в наличии/не найден → не шлём', async () => {
    tokens = [];
    assert.equal((await runCartReminders(NOW)).sent, 0);
    base(); events[0].phone = null;
    assert.equal((await runCartReminders(NOW)).candidates, 0);
    base(); products[0].shopActive = false;
    assert.equal((await runCartReminders(NOW)).sent, 0);
    base(); products[0].shopStock = 0;
    assert.equal((await runCartReminders(NOW)).sent, 0);
    base(); products = [];
    assert.equal((await runCartReminders(NOW)).sent, 0);
    assert.equal(expoCalls.length, 0);
  });

  test('товар находится и по артикулу витрины (sku события = shopArticle)', async () => {
    events[0].sku = '1000001';
    assert.equal((await runCartReminders(NOW)).sent, 1);
  });

  test('два разных покупателя → каждому свой пуш', async () => {
    events.push({ id: 'e5', type: 'cart', sku: 'SKU-1', phone: '77025556677', createdAt: ago(28) });
    tokens.push({ phone: '77025556677', token: 'ExponentPushToken[def]' });
    const r = await runCartReminders(NOW);
    assert.equal(r.sent, 2);
    assert.deepEqual(expoCalls.map((m) => m.to).sort(), ['ExponentPushToken[abc]', 'ExponentPushToken[def]']);
  });
});
