/**
 * Онлайн-касса re:Kassa: тело чека по заказу (товары + доставка, тиыны), один чек на заказ
 * (повтор после ошибки — с тем же X-Request-ID), чек возврата только после чека продажи.
 * Сеть re:Kassa и БД — заглушки.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.REKASSA_API_KEY = 'test-key';
process.env.REKASSA_KASSA_NUMBER = 'ZNM-1';
process.env.REKASSA_KASSA_PASSWORD = 'pw';

type Row = Record<string, any>;
let orders: Row[] = [];
let receipts: Row[] = [];
let seq = 0;
let pushes: Row[] = [];
const stub: Record<string, any> = {
  shopCustomerPushToken: { findFirst: async (a: Row) => (a.where.phone.in.includes('+77771112233') ? { token: 'tok' } : null) },
  shopOrder: { findUnique: async (a: Row) => orders.find((o) => o.id === a.where.id) ?? null },
  fiscalReceipt: {
    findUnique: async (a: Row) => {
      const k = a.where.orderId_operation;
      return receipts.find((r) => r.orderId === k.orderId && r.operation === k.operation) ?? null;
    },
    create: async (a: Row) => { const r = { id: `r${++seq}`, status: 'pending', ...a.data }; receipts.push(r); return r; },
    update: async (a: Row) => { const r = receipts.find((x) => x.id === a.where.id)!; Object.assign(r, a.data); return r; },
  },
};
class StubPrismaClient {
  constructor() {
    return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; return stub[key as string] ?? new Proxy({}, { get: () => async () => [] }); } });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
const pbPath = require.resolve('../src/services/pushBroadcast.service');
require.cache[pbPath] = { id: pbPath, filename: pbPath, loaded: true, exports: { sendBroadcast: async (m: Row) => { pushes.push(m); return {}; } } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rk = require('../src/services/rekassa.service');

let calls: { url: string; init: any }[] = [];
let ticketReply: { status: number; body: any } = { status: 200, body: { id: 77, ticketNumber: '123', qrCode: 'https://ofd/check?i=123', offline: false } };
function fakeFetch(url: string, init: any) {
  calls.push({ url, init });
  const json = (status: number, body: any) => Promise.resolve({ ok: status < 400, status, json: async () => body } as any);
  if (url.includes('/api/auth/login')) return json(200, { token: 'T', id: 555, cashRegisterPassword: '0000' });
  if (/\/tickets\/\d+\/receipts$/.test(url)) return json(200, {});
  if (url.endsWith('/tickets')) return json(ticketReply.status, ticketReply.body);
  return json(404, {});
}

beforeEach(() => {
  orders = [{ id: 'o1', number: 'MM-1', total: 4000, phone: '+7 777 111 22 33', status: 'paid', email: null,
    items: JSON.stringify([{ sku: 'a', name: 'Чайник', price: 1500, quantity: 2 }]) }];
  receipts = []; calls = []; seq = 0; pushes = [];
  ticketReply = { status: 200, body: { id: 77, ticketNumber: '123', qrCode: 'https://ofd/check?i=123', offline: false } };
  rk.setRekassaFetch(fakeFetch as any);
});

describe('re:Kassa', () => {
  test('тело чека: товары, доставка отдельной строкой, сумма в тиынах, оплата картой', () => {
    const { body, total } = rk.ticketFor({ total: 2999.5, items: JSON.stringify([{ name: 'Кружка', price: 999.75, quantity: 2 }]) }, 'sell');
    assert.equal(total, 2999.5);
    assert.equal(body.operation, 'OPERATION_SELL');
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items[0].commodity.price, { bills: '999', coins: 75 });
    assert.equal(body.items[0].commodity.quantity, 2000);
    assert.deepEqual(body.items[1].commodity.sum, { bills: '1000', coins: 0 }); // доставка 2999.5 − 1999.5
    assert.deepEqual(body.payments[0], { type: 'PAYMENT_CARD', sum: { bills: '2999', coins: 50 } });
    assert.equal(rk.ticketFor({ total: 1, items: '[]' }, 'return').body.operation, 'OPERATION_SELL_RETURN');
  });

  test('чек пробивается один раз; ссылка на чек сохраняется; без почты — выдача ссылкой, пуш покупателю', async () => {
    const r = await rk.fiscalizeOrder('o1', 'sell');
    assert.equal(r.status, 'ok');
    assert.equal(r.qrUrl, 'https://ofd/check?i=123');
    const sale = calls.find((c) => c.url.endsWith('/api/crs/555/tickets'))!;
    assert.ok(sale.init.headers['X-Request-ID']);
    assert.equal(sale.init.headers.Authorization, 'Bearer T');
    const receipt = calls.find((c) => c.url.endsWith('/tickets/77/receipts'))!;
    assert.deepEqual(JSON.parse(receipt.init.body), { type: 'DOWNLOAD' });
    assert.equal(pushes.length, 1);
    assert.match(pushes[0].title, /Чек по заказу/);
    assert.deepEqual(pushes[0].data, { type: 'order', orderNumber: 'MM-1' });
    const n = calls.length;
    await rk.fiscalizeOrder('o1', 'sell'); // повтор — без нового чека
    assert.equal(calls.length, n);
  });

  test('ошибка кассы записывается; повтор идёт с тем же X-Request-ID', async () => {
    ticketReply = { status: 400, body: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: 'ОФД недоступен' } };
    await assert.rejects(() => rk.fiscalizeOrder('o1', 'sell'));
    assert.equal(receipts[0].status, 'error');
    assert.match(receipts[0].error, /SERVICE_TEMPORARILY_UNAVAILABLE/);
    const firstId = calls.find((c) => c.url.endsWith('/tickets'))!.init.headers['X-Request-ID'];
    ticketReply = { status: 200, body: { id: 78, offlineTicketNumber: '9', offline: true } };
    const r = await rk.fiscalizeOrder('o1', 'sell');
    assert.equal(r.status, 'offline');
    const ids = calls.filter((c) => c.url.endsWith('/tickets')).map((c) => c.init.headers['X-Request-ID']);
    assert.deepEqual(ids, [firstId, firstId]);
  });

  test('покупатель оставил e-mail — касса отправляет чек на почту', async () => {
    orders[0].email = 'buyer@mail.kz';
    await rk.fiscalizeOrder('o1', 'sell');
    const receipt = calls.find((c) => c.url.endsWith('/tickets/77/receipts'))!;
    assert.deepEqual(JSON.parse(receipt.init.body), { type: 'EMAIL', receiver: { email: 'buyer@mail.kz' } });
    assert.match(pushes[0].body, /почте/);
  });

  test('чек возврата — только после чека продажи', async () => {
    await assert.rejects(() => rk.fiscalizeOrder('o1', 'return'), /возвращать нечего/);
    await rk.fiscalizeOrder('o1', 'sell');
    const r = await rk.fiscalizeOrder('o1', 'return');
    assert.equal(r.operation, 'return');
    const bodies = calls.filter((c) => c.url.endsWith('/tickets')).map((c) => JSON.parse(c.init.body).operation);
    assert.deepEqual(bodies, ['OPERATION_SELL', 'OPERATION_SELL_RETURN']);
  });
});
