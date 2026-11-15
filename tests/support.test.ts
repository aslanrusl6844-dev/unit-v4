/**
 * Чат с оператором из чата Баурсака: старт, сообщения покупателя, ответ оператора реплаем
 * и по «#номер», кнопки «Взять» / «Завершить», защита токеном. БД и Telegram — заглушки.
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
process.env.TELEGRAM_BOT_TOKEN = '123:test';
process.env.TELEGRAM_CHAT_IDS = '111,222';

type Row = Record<string, any>;
let chats: Row[] = [];
let messages: Row[] = [];
let refs: Row[] = [];
let chatSeq = 0;
let msgSeq = 0;
let tgSeq = 1000;
let sent: Array<{ method: string; body: Row }> = [];

const stub: Record<string, any> = {
  supportChat: {
    create: async (a: Row) => { const c = { id: `c${++chatSeq}`, number: chatSeq, createdAt: new Date(), operatorName: null, operatorTgChatId: null, ...a.data }; chats.push(c); return { ...c }; },
    findUnique: async (a: Row) => { const c = chats.find((x) => (a.where.id ? x.id === a.where.id : x.number === a.where.number)); return c ? { ...c } : null; },
    update: async (a: Row) => { const c = chats.find((x) => x.id === a.where.id)!; Object.assign(c, a.data); return { ...c }; },
    updateMany: async (a: Row) => {
      const c = chats.find((x) => x.id === a.where.id && (!a.where.status || x.status === a.where.status));
      if (!c) return { count: 0 };
      Object.assign(c, a.data);
      return { count: 1 };
    },
  },
  supportMessage: {
    create: async (a: Row) => { const m = { id: ++msgSeq, createdAt: new Date(), operatorName: null, ...a.data }; messages.push(m); return { ...m }; },
    findMany: async (a: Row) => messages.filter((m) => m.chatId === a.where.chatId && m.id > (a.where.id?.gt ?? 0)).sort((x, y) => x.id - y.id),
  },
  supportTgRef: {
    create: async (a: Row) => { refs.push({ ...a.data }); return a.data; },
    findUnique: async (a: Row) => {
      const k = a.where.tgChatId_tgMessageId;
      return refs.find((r) => r.tgChatId === k.tgChatId && r.tgMessageId === k.tgMessageId) ?? null;
    },
  },
  shopCustomerPushToken: { findUnique: async () => null },
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

// Telegram API — заглушка: запоминаем вызовы, отдаём message_id.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop()!;
    sent.push({ method, body: JSON.parse(init?.body ?? '{}') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++tgSeq } }), { status: 200 });
  }
  return realFetch(url, init);
}) as any;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const support = require('../src/services/support.service');

let port = 0;
let server: http.Server;
function call(method: string, path: string, body?: unknown, headers: Row = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'x-app-key': APP_KEY, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const BASE = '/api/shop/assistant/support';
const start = () => call('POST', `${BASE}/start`, {
  phone: '+7 700 555 00 11', customerName: 'Айгерим', question: 'Соедините с оператором',
  history: [{ fromUser: true, text: 'Где мой заказ?' }, { fromUser: false, text: 'Подскажите номер заказа {{123}} [[Да | Нет]]' }],
});
const tgMessages = () => sent.filter((s) => s.method === 'sendMessage');

before(async () => { server = app.listen(0); port = (server.address() as any).port; });
after(() => { server.close(); globalThis.fetch = realFetch; });
beforeEach(() => { chats = []; messages = []; refs = []; sent = []; chatSeq = 0; msgSeq = 0; });

describe('распознавание просьбы', () => {
  test('оператор / менеджер / живой человек', () => {
    for (const t of ['Соедините с оператором', 'позовите менеджера', 'хочу живого человека', 'Operator please']) assert.equal(support.isOperatorRequest(t), true, t);
    for (const t of ['Нужен блендер', 'Где мой заказ?']) assert.equal(support.isOperatorRequest(t), false, t);
  });
});

describe('чат с оператором', () => {
  test('старт: чат ждёт оператора, всем операторам ушёл запрос с историей и кнопкой «Взять»', async () => {
    const r = await start();
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'waiting');
    assert.ok(r.json.token.length >= 32);
    assert.equal(r.json.messages[0].sender, 'system');
    const out = tgMessages();
    assert.deepEqual(out.map((s) => s.body.chat_id).sort(), ['111', '222']);
    assert.match(out[0].body.text, /Новый чат #1/);
    assert.match(out[0].body.text, /Где мой заказ/);
    assert.doesNotMatch(out[0].body.text, /\{\{|\[\[/);
    assert.equal(out[0].body.reply_markup.inline_keyboard[0][0].callback_data, `sup:take:${r.json.id}`);
  });

  test('без x-app-key и с чужим токеном — нельзя', async () => {
    const r = await start();
    assert.equal((await call('GET', `${BASE}/${r.json.id}`, undefined, { 'x-app-key': 'bad' })).status, 401);
    assert.equal((await call('GET', `${BASE}/${r.json.id}`, undefined, { 'x-support-token': 'wrong-token' })).status, 404);
    assert.equal((await call('POST', `${BASE}/${r.json.id}/messages`, { text: 'hi' }, { 'x-support-token': 'wrong-token' })).status, 404);
  });

  test('оператор взял, ответил реплаем — ответ в приложении; новые сообщения клиента идут только ему', async () => {
    const r = await start();
    const h = { 'x-support-token': r.json.token };
    const firstRef = refs.find((x) => x.tgChatId === '111')!;
    await support.handleSupportUpdate({ callback_query: { id: 'cb1', data: `sup:take:${r.json.id}`, from: { id: 1, first_name: 'Аслан' }, message: { chat: { id: 111 } } } });
    let st = await call('GET', `${BASE}/${r.json.id}?after=0`, undefined, h);
    assert.equal(st.json.status, 'active');
    assert.equal(st.json.operatorName, 'Аслан');
    assert.match(st.json.messages.at(-1).text, /Аслан подключился/);

    const handled = await support.handleSupportUpdate({ message: { message_id: 5, chat: { id: 111 }, from: { id: 1, first_name: 'Аслан' }, text: 'Здравствуйте! Сейчас проверю заказ.', reply_to_message: { message_id: firstRef.tgMessageId } } });
    assert.equal(handled, true);
    const lastSeen = st.json.messages.at(-1).id;
    st = await call('GET', `${BASE}/${r.json.id}?after=${lastSeen}`, undefined, h);
    assert.equal(st.json.messages.length, 1);
    assert.equal(st.json.messages[0].sender, 'operator');
    assert.equal(st.json.messages[0].operatorName, 'Аслан');

    sent = [];
    const m = await call('POST', `${BASE}/${r.json.id}/messages`, { text: 'Заказ MM-4512' }, h);
    assert.equal(m.status, 200);
    assert.deepEqual(tgMessages().map((s) => s.body.chat_id), ['111']);
    assert.match(tgMessages()[0].body.text, /MM-4512/);
  });

  test('«#номер текст» — ответ без реплая; второй оператор взять занятый чат не может', async () => {
    const r = await start();
    await support.handleSupportUpdate({ message: { chat: { id: 111 }, from: { id: 1, first_name: 'Аслан' }, text: '#1 Добрый день!' } });
    assert.equal(chats[0].status, 'active');
    assert.equal(chats[0].operatorTgChatId, '111');
    await support.handleSupportUpdate({ callback_query: { id: 'cb2', data: `sup:take:${r.json.id}`, from: { id: 2, first_name: 'Аружан' }, message: { chat: { id: 222 } } } });
    assert.equal(chats[0].operatorName, 'Аслан');
    assert.ok(tgMessages().some((s) => s.body.chat_id === '222' && /уже взял/.test(s.body.text)));
  });

  test('оператор завершил — чат закрыт, писать в него нельзя', async () => {
    const r = await start();
    const h = { 'x-support-token': r.json.token };
    await support.handleSupportUpdate({ callback_query: { id: 'cb3', data: `sup:close:${r.json.id}`, from: { id: 1, first_name: 'Аслан' }, message: { chat: { id: 111 } } } });
    const st = await call('GET', `${BASE}/${r.json.id}`, undefined, h);
    assert.equal(st.json.status, 'closed');
    assert.match(st.json.messages.at(-1).text, /Баурсак/);
    assert.equal((await call('POST', `${BASE}/${r.json.id}/messages`, { text: 'ещё вопрос' }, h)).status, 409);
  });

  test('покупатель завершил чат сам', async () => {
    const r = await start();
    const h = { 'x-support-token': r.json.token };
    assert.equal((await call('POST', `${BASE}/${r.json.id}/close`, {}, h)).status, 200);
    assert.equal(chats[0].status, 'closed');
    assert.equal(chats[0].closedBy, 'customer');
  });

  test('чужие сообщения боту (не реплай на чат поддержки) отдаются агенту товаров', async () => {
    await start();
    assert.equal(await support.handleSupportUpdate({ message: { chat: { id: 111 }, from: { id: 1 }, text: 'новый товар' } }), false);
    assert.equal(await support.handleSupportUpdate({ message: { chat: { id: 111 }, from: { id: 1 }, text: 'ok', reply_to_message: { message_id: 1 } } }), false);
    // Не разрешённый чат — ничего не делаем.
    assert.equal(await support.handleSupportUpdate({ message: { chat: { id: 999 }, from: { id: 9 }, text: '#1 взлом' } }), false);
    assert.equal(chats[0].status, 'waiting');
  });
});
