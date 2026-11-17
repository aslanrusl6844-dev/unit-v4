/**
 * Озон-менеджер (отдельный Telegram-бот): сроки отгрузки FBS, закупка под заказы по закупочной цене,
 * доступ только владельцу, «мозг» Claude с инструментами (и без поиска, если он выключен у аккаунта),
 * фото товара для анализа конкурентов. Ozon, Telegram, Claude и БД — заглушки.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.OZON_BOT_TOKEN = 'tok';
process.env.OZON_BOT_OWNER_ID = '111';
process.env.ANTHROPIC_API_KEY = 'k';

type Row = Record<string, any>;
let botMessages: Row[] = [];
const products: Row[] = [
  { sku: 'A', ozonOfferId: 'A', costPrice: 1000, packagingCost: 50, name: 'Чайник', images: '["https://cdn/a.jpg"]', marketImages: null },
  { sku: 'B', ozonOfferId: 'B', costPrice: 0, packagingCost: 0, name: 'Кружка', images: null, marketImages: '[]' },
];
const stub: Record<string, any> = {
  product: { findMany: async () => products },
  ozonBotMessage: {
    findMany: async () => [...botMessages].reverse(),
    createMany: async (a: Row) => { botMessages.push(...a.data); return { count: a.data.length }; },
    deleteMany: async () => { const n = botMessages.length; botMessages = []; return { count: n }; },
  },
};
class StubPrismaClient {
  constructor() {
    return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; return stub[key as string] ?? new Proxy({}, { get: () => async () => [] }); } });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ozonClient } = require('../src/integrations/ozon.client');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const om = require('../src/services/ozonManager.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bot = require('../src/routes/ozonBot.routes');

const H = 3600_000;
let sent: { chat: string; text: string }[] = [];
let photos: Row[] = [];
let claudeCalls: any[] = [];
let claudeReplies: any[] = [];

beforeEach(() => {
  botMessages = []; sent = []; claudeCalls = []; claudeReplies = []; photos = [];
  const now = Date.now();
  ozonClient.fetchFbsPostings = async () => [
    { postingNumber: 'P-late', status: 'awaiting_packaging', scanit: 'ii50173001436', inProcessAt: null, shipmentDate: new Date(now - 2 * H).toISOString(), products: [{ offerId: 'A', name: 'Чайник', quantity: 2, price: 5000 }] },
    { postingNumber: 'P-later', status: 'awaiting_deliver', inProcessAt: null, shipmentDate: new Date(now + 72 * H).toISOString(), products: [{ offerId: 'A', name: 'Чайник', quantity: 1, price: 5000 }] },
    { postingNumber: 'P-b', status: 'awaiting_packaging', scanit: 'ii50173002383', inProcessAt: null, shipmentDate: new Date(now + 72 * H).toISOString(), products: [{ offerId: 'B', name: 'Кружка', quantity: 3, price: 900 }] },
    { postingNumber: 'P-done', status: 'delivering', inProcessAt: null, shipmentDate: new Date(now - 48 * H).toISOString(), products: [{ offerId: 'A', name: 'Чайник', quantity: 1, price: 5000 }] },
  ];
  bot.setOzonBotTelegramFetch((async (url: string, init: any) => {
    const body: Row = init?.body instanceof FormData
      ? { chat_id: init.body.get('chat_id'), caption: init.body.get('caption'), file: init.body.get('photo') }
      : init?.body ? JSON.parse(init.body) : {};
    if (url.endsWith('/sendMessage')) sent.push({ chat: String(body.chat_id), text: body.text });
    if (url.endsWith('/sendPhoto')) photos.push(body);
    if (url.endsWith('/getFile')) return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'photos/x.jpg' } }) };
    if (url.includes('/file/bot')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  }) as any);
  bot.setOzonBotImageFetch((async (url: string) => ({
    ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer, url,
  })) as any);
  om.setOzonBotFetch((async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    claudeCalls.push(body);
    const reply = claudeReplies.shift() ?? { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as any;
  }) as any);
});

describe('Озон-менеджер', () => {
  test('отгрузки FBS: просроченные отдельно, отгруженные не считаются', async () => {
    const s = await om.fbsToShip();
    assert.equal(s.total, 3);
    assert.equal(s.overdue, 1);
    assert.equal(s.postings[0].postingNumber, 'P-late');
    assert.equal(s.postings.find((p: Row) => p.postingNumber === 'P-later').needPacking, false);
  });

  test('закупка: только несобранные, по закупочной цене + упаковка; без цены — помечено', async () => {
    const b = await om.purchaseNeeds();
    assert.equal(b.totalPurchase, 2 * 1050); // 2 чайника (третий уже собран), кружки без цены
    assert.deepEqual(b.missingCost, ['B']);
    assert.equal(b.items.find((i: Row) => i.offerId === 'A').qty, 2);
    assert.deepEqual(b.items.find((i: Row) => i.offerId === 'A').stickers, ['1436']); // 4 цифры со стикера Ozon
    assert.equal(om.stickerCode('ii50173002383'), '2383');
    assert.equal(om.stickerCode(''), '');
  });

  test('чужим бот не отвечает; /buy владельцу — сумма закупки', async () => {
    await bot.handleOzonBotUpdate({ message: { chat: { id: 999 }, text: '/buy' } });
    assert.equal(sent.length, 0);
    await bot.handleOzonBotUpdate({ message: { chat: { id: 111 }, text: '/buy' } });
    assert.match(sent[0].text, /Закупка под заказы/);
    assert.match(sent[0].text, /2[\s ]?100 ₸/);
  });

  test('мозг: Claude зовёт инструмент, получает данные и отвечает; диалог запоминается', async () => {
    claudeReplies = [
      { status: 200, body: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'purchase_needs', input: {} }] } },
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'На закупку нужно 2 100 ₸' }] } },
    ];
    await bot.handleOzonBotUpdate({ message: { chat: { id: 111 }, text: 'сколько денег на закупку?' } });
    assert.equal(claudeCalls.length, 2);
    assert.ok(claudeCalls[0].tools.some((t: Row) => t.name === 'web_search'));
    const result = claudeCalls[1].messages.at(-1).content[0];
    assert.equal(result.type, 'tool_result');
    assert.match(result.content, /"totalPurchase":2100/);
    assert.equal(sent.at(-1)!.text, 'На закупку нужно 2 100 ₸');
    assert.equal(botMessages.length, 2);
  });

  test('поиск не включён у аккаунта Anthropic — повтор без него', async () => {
    claudeReplies = [
      { status: 400, body: { error: { message: 'web search is not enabled for this organization' } } },
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Без поиска' }] } },
    ];
    const a = await om.askOzonManager([], 'конкуренты?');
    assert.equal(a, 'Без поиска');
    assert.ok(!claudeCalls[1].tools.some((t: Row) => t.name === 'web_search'));
  });

  test('модель недоступна аккаунту — бот берёт следующую', async () => {
    claudeReplies = [
      { status: 404, body: { error: { type: 'not_found_error', message: 'model: claude-sonnet-4-5-20250929' } } },
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Работаю' }] } },
    ];
    const a = await om.askOzonManager([], 'привет');
    assert.equal(a, 'Работаю');
    assert.notEqual(claudeCalls[0].model, claudeCalls[1].model);
  });

  test('фото товара уходит в Claude картинкой вместе с подписью', async () => {
    await bot.handleOzonBotUpdate({ message: { chat: { id: 111 }, caption: 'Чайник, закупка 3000', photo: [{ file_id: 's' }, { file_id: 'big' }] } });
    const content = claudeCalls[0].messages.at(-1).content;
    assert.equal(content[0].type, 'image');
    assert.equal(content[0].source.media_type, 'image/jpeg');
    assert.equal(content[1].text, 'Чайник, закупка 3000');
    assert.match(sent[0].text, /ищу конкурентов/);
  });

  test('семейная группа: отвечает в группе из списка, отчёты — первому в списке', async () => {
    const prev = process.env.OZON_BOT_OWNER_ID;
    process.env.OZON_BOT_OWNER_ID = '-100500, 111';
    await bot.handleOzonBotUpdate({ message: { chat: { id: -100500, type: 'supergroup' }, from: { first_name: 'Айгерим' }, text: '/ship@MyOzonBot' } });
    await bot.handleOzonBotUpdate({ message: { chat: { id: -100500, type: 'supergroup' }, from: { first_name: 'Айгерим' }, text: 'как дела?' } });
    process.env.OZON_BOT_OWNER_ID = prev;
    assert.match(sent[0].text, /Отгрузка FBS/);
    assert.equal(sent[0].chat, '-100500');
    assert.equal(claudeCalls[0].messages.at(-1).content, '[Айгерим] как дела?');
  });

  test('/collect: столбиком — по картинке на товар, без подписи; одинаковые сложены; цен нет', async () => {
    await bot.handleOzonBotUpdate({ message: { chat: { id: 111 }, text: '/collect' } });
    assert.equal(photos.length, 2); // Кружка ×3, Чайник ×2
    assert.ok(photos.every((p) => p.file instanceof Blob && p.file.size > 1000 && !p.caption));
    assert.match(sent[0].text, /2 товаров, 5 шт/);
    assert.doesNotMatch(sent.map((x) => x.text).join(' '), /₸/);
  });

  test('«покажи с фото, что собрать» — Claude зовёт show_photos, фото уходят в этот чат', async () => {
    claudeReplies = [
      { status: 200, body: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'show_photos', input: { kind: 'collect' } }] } },
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Отправил фото: 2 товара, 5 шт' }] } },
    ];
    await bot.handleOzonBotUpdate({ message: { chat: { id: 111 }, text: 'покажи фотками что собрать у оптовиков' } });
    assert.equal(photos.length, 2);
    assert.equal(String(photos[0].chat_id), '111');
    assert.match(claudeCalls[1].messages.at(-1).content[0].content, /"sent":true/);
  });

  test('/sold: что продалось сегодня — прямо из Ozon, отмены не считаются', async () => {
    ozonClient.fetchFboPostings = async () => [{ postingNumber: 'F1', status: 'delivered', createdAt: null, offerId: 'A', name: 'Чайник', quantity: 1, price: 5000 }];
    const r = await om.photoCards('sold');
    const a = r.cards.find((c: Row) => c.offerId === 'A');
    assert.equal(a.qty, 5); // FBS: 2 + 1 + 1 (delivering) + FBO 1
    assert.equal(a.photo, 'https://cdn/a.jpg');
  });

  test('фото не скачалось — картинка всё равно уходит (с названием вместо фото)', async () => {
    bot.setOzonBotImageFetch((async () => ({ ok: false, status: 403 })) as any);
    await bot.sendPhotoCards('111', 'Тест', [{ offerId: 'A', name: 'Чайник', qty: 2, photo: 'https://cdn/a.jpg' }]);
    assert.equal(photos.length, 1);
    assert.ok(photos[0].file.size > 1000);
  });

  test('без владельца бот присылает chat id для настройки', async () => {
    const prev = process.env.OZON_BOT_OWNER_ID;
    delete process.env.OZON_BOT_OWNER_ID;
    await bot.handleOzonBotUpdate({ message: { chat: { id: 555 }, text: '/start' } });
    process.env.OZON_BOT_OWNER_ID = prev;
    assert.match(sent[0].text, /555/);
  });
});
