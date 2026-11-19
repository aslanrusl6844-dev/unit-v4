/**
 * My Market Live: эфиры (токен Agora, «зависший» эфир закрывается), чат (телефоны и ссылки вырезаются),
 * шортс (лента только опубликованных, лайки), проверка видео в админке. БД — заглушка в памяти.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const APP_KEY = randomBytes(8).toString('hex');
const ADMIN_USER = 'admin-test';
const ADMIN_PASSWORD = randomBytes(12).toString('hex');
process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = APP_KEY;
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.AGORA_APP_CERTIFICATE = 'a'.repeat(32);

type Row = Record<string, any>;
let creators: Row[] = [];
let streams: Row[] = [];
let videos: Row[] = [];
let likes: Row[] = [];
let chat: Row[] = [];
let liveCats: Row[] = [];
let banners: Row[] = [];
let follows: Row[] = [];
let reminders: Row[] = [];
let orders: Row[] = [];
let gifts: Row[] = [];
let giftSends: Row[] = [];
const products: Row[] = [
  { sku: 'ozon-1', shopArticle: '1000001', category: 'Красота и здоровье' },
  { sku: 'ozon-2', shopArticle: '1000002', category: 'Дом и сад' },
];
let seq = 0;

const match = (x: Row, w: Row = {}): boolean => Object.entries(w).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(x[k]);
    if ('not' in v) return v.not === null ? x[k] != null : x[k] !== v.not;
    if ('lte' in v) return x[k] != null && x[k] <= v.lte;
    if ('gt' in v) return x[k] > v.gt;
    if ('lt' in v) return x[k] != null && x[k] < v.lt;
    if ('gte' in v) return x[k] != null && x[k] >= v.gte;
    return true;
  }
  return x[k] === v;
});
const table = (rows: () => Row[], set: (r: Row[]) => void, idNum = false) => ({
  findUnique: async (a: Row) => {
    const w = a.where;
    if (w.videoId_deviceKey) return rows().find((r) => r.videoId === w.videoId_deviceKey.videoId && r.deviceKey === w.videoId_deviceKey.deviceKey) ?? null;
    return rows().find((r) => match(r, w)) ?? null;
  },
  findMany: async (a: Row = {}) => {
    let out = rows().filter((r) => match(r, a.where));
    const ob = a.orderBy && Object.entries(a.orderBy)[0];
    if (ob) out = [...out].sort((p: Row, q: Row) => (p[ob[0]] > q[ob[0]] ? 1 : -1) * (ob[1] === 'desc' ? -1 : 1));
    return a.take ? out.slice(0, a.take) : out;
  },
  create: async (a: Row) => { const r = { id: idNum ? ++seq : `id${++seq}`, createdAt: new Date(Date.now() + seq), likes: 0, views: 0, peakViewers: 0, ...a.data }; rows().push(r); return { ...r }; },
  update: async (a: Row) => {
    const r = rows().find((x) => x.id === a.where.id)!;
    for (const [k, v] of Object.entries(a.data)) {
      if (v && typeof v === 'object' && 'increment' in (v as Row)) r[k] = (r[k] ?? 0) + (v as Row).increment;
      else if (v && typeof v === 'object' && 'decrement' in (v as Row)) r[k] = (r[k] ?? 0) - (v as Row).decrement;
      else r[k] = v;
    }
    return { ...r };
  },
  updateMany: async (a: Row) => {
    let n = 0;
    rows().forEach((r) => {
      if (!match(r, a.where)) return;
      n += 1;
      for (const [k, v] of Object.entries(a.data)) r[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? (r[k] ?? 0) + (v as Row).increment : v;
    });
    return { count: n };
  },
  delete: async (a: Row) => { set(rows().filter((r) => r.id !== a.where.id)); return {}; },
});
const stub: Record<string, any> = {
  creator: table(() => creators, (r) => { creators = r; }),
  liveStream: table(() => streams, (r) => { streams = r; }),
  creatorVideo: table(() => videos, (r) => { videos = r; }),
  creatorVideoLike: table(() => likes, (r) => { likes = r; }, true),
  liveChatMessage: table(() => chat, (r) => { chat = r; }, true),
  liveCategory: {
    ...table(() => liveCats, (r) => { liveCats = r; }),
    deleteMany: async (a: Row) => { const n = liveCats.length; liveCats = liveCats.filter((c) => c.id !== a.where.id); return { count: n - liveCats.length }; },
  },
  liveBanner: {
    ...table(() => banners, (r) => { banners = r; }),
    deleteMany: async (a: Row) => { const n = banners.length; banners = banners.filter((c) => c.id !== a.where.id); return { count: n - banners.length }; },
  },
  liveFollow: {
    ...table(() => follows, (r) => { follows = r; }),
    findUnique: async (a: Row) => {
      const k = a.where.creatorId_deviceKey;
      return k ? follows.find((f) => f.creatorId === k.creatorId && f.deviceKey === k.deviceKey) ?? null : follows.find((f) => f.id === a.where.id) ?? null;
    },
  },
  liveReminder: {
    ...table(() => reminders, (r) => { reminders = r; }),
    findUnique: async (a: Row) => {
      const k = a.where.streamId_deviceKey;
      return k ? reminders.find((f) => f.streamId === k.streamId && f.deviceKey === k.deviceKey) ?? null : reminders.find((f) => f.id === a.where.id) ?? null;
    },
  },
  liveGift: table(() => gifts, (r) => { gifts = r; }),
  liveGiftSend: table(() => giftSends, (r) => { giftSends = r; }, true),
  shopOrder: { findMany: async () => orders.map((o) => ({ items: o.items })) },
  product: { findMany: async (a: Row) => { const list = a.where.OR[0].shopArticle.in; return products.filter((p) => list.includes(p.shopArticle) || list.includes(p.sku)); } },
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetEventThrottle } = require('../src/services/liveGifts.service');

let port = 0;
let server: http.Server;
function call(method: string, path: string, body?: unknown, admin = false): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Row = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) };
    if (admin) {
      headers.authorization = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64')}`;
      headers.origin = `http://127.0.0.1:${port}`;
    } else headers['x-app-key'] = APP_KEY;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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
const PHONE = '77011112233';

before(async () => { server = app.listen(0); port = (server.address() as any).port; });
after(() => server.close());
beforeEach(() => {
  creators = [{ id: 'cr1', phone: PHONE, name: 'Айгерим', code: 'MM-ABCDE', percent: 7, active: true, autoPublish: false }];
  streams = []; videos = []; likes = []; chat = []; liveCats = []; banners = []; follows = []; reminders = []; orders = []; gifts = []; giftSends = []; seq = 0;
  resetEventThrottle();
});

describe('эфиры', () => {
  test('не креатор эфир начать не может; креатор получает токен ведущего', async () => {
    assert.equal((await call('POST', '/api/shop/live/creator/streams/start', { phone: '77000000000', title: 'Тест', skus: ['1'] })).status, 403);
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Кухня', skus: ['1000001', '1000002'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'live');
    assert.equal(r.json.join.appId, 'eddfb3532542449897a94b234761dbc8');
    assert.ok(r.json.join.token.length > 50);
    const home = await call('GET', '/api/shop/live/home');
    assert.equal(home.json.live.length, 1);
    assert.deepEqual(home.json.live[0].skus, ['1000001', '1000002']);
    const viewer = await call('GET', `/api/shop/live/streams/${r.json.id}`);
    assert.ok(viewer.json.join.token);
  });

  test('креатор пропал (нет отметок 90 с) — эфир закрывается сам', async () => {
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Кухня', skus: ['1'] });
    streams[0].lastBeatAt = new Date(Date.now() - 120_000);
    const home = await call('GET', '/api/shop/live/home');
    assert.equal(home.json.live.length, 0);
    assert.equal(streams[0].status, 'ended');
    assert.equal((await call('GET', `/api/shop/live/streams/${r.json.id}`)).json.join, null);
  });

  test('анонс → вкладка «Анонсы», потом старт этого же эфира', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const s = await call('POST', '/api/shop/live/creator/streams/schedule', { phone: PHONE, title: 'Вечерний эфир', skus: ['1'], scheduledAt: at });
    assert.equal(s.status, 201);
    assert.equal((await call('GET', '/api/shop/live/home')).json.upcoming.length, 1);
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, streamId: s.json.id });
    assert.equal(r.json.status, 'live');
    await call('POST', `/api/shop/live/creator/streams/${s.json.id}/stop`, { phone: PHONE });
    assert.equal(streams[0].status, 'ended');
  });

  test('чат: телефоны и ссылки вырезаются, после эфира писать нельзя', async () => {
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Кухня', skus: ['1'] });
    await call('POST', `/api/shop/live/streams/${r.json.id}/chat`, { name: 'Аня', text: 'Пишите мне +7 701 234 56 78 или wa.me/7701' });
    await call('POST', `/api/shop/live/streams/${r.json.id}/chat`, { name: 'Айгерим', text: 'Привет всем!', phone: PHONE });
    const c = await call('GET', `/api/shop/live/streams/${r.json.id}/chat?after=0`);
    assert.equal(c.json.messages.length, 2);
    assert.doesNotMatch(c.json.messages[0].text, /701|wa\.me/);
    assert.equal(c.json.messages[1].fromHost, true);
    await call('POST', `/api/shop/live/creator/streams/${r.json.id}/stop`, { phone: PHONE });
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/chat`, { text: 'ещё' })).status, 409);
  });
});

describe('лайки и просмотры эфира', () => {
  test('♥ эфира ставится один раз с устройства и снимается; просмотр повтора считается', async () => {
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Кухня', skus: ['1'] });
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/like`, { device: 'd1' })).json.likes, 1);
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/like`, { device: 'd1' })).json.likes, 1);
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/like`, { device: 'd2' })).json.likes, 2);
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/like`, { device: 'd1', like: false })).json.likes, 1);
    streams[0].replayUrl = 'https://p/r.mp4';
    await call('POST', `/api/shop/live/streams/${r.json.id}/view`, {});
    assert.equal(streams[0].views, 1);
  });
});

describe('шортс', () => {
  test('в ленте только одобренные; админ одобряет; лайк ставится и снимается', async () => {
    videos.push({ id: 'v1', creatorId: 'cr1', title: 'Блендер', videoUrl: 'https://pub/v1.mp4', skus: '["1000001"]', status: 'pending', likes: 0, views: 0, createdAt: new Date() });
    assert.equal((await call('GET', '/api/shop/live/shorts')).json.items.length, 0);
    const pending = await call('GET', '/api/shop-admin/live/videos?status=pending', undefined, true);
    assert.equal(pending.json.length, 1);
    await call('POST', '/api/shop-admin/live/videos/v1/status', { status: 'published' }, true);
    const feed = await call('GET', '/api/shop/live/shorts?device=d1');
    assert.equal(feed.json.items.length, 1);
    assert.equal(feed.json.items[0].creatorName, 'Айгерим');
    assert.equal((await call('POST', '/api/shop/live/shorts/v1/like', { device: 'd1' })).json.likes, 1);
    assert.equal((await call('POST', '/api/shop/live/shorts/v1/like', { device: 'd1' })).json.likes, 1); // повторный лайк не считается
    assert.equal((await call('GET', '/api/shop/live/shorts?device=d1')).json.items[0].liked, true);
    assert.equal((await call('POST', '/api/shop/live/shorts/v1/like', { device: 'd1', like: false })).json.likes, 0);
  });

  test('видео загружает только креатор', async () => {
    const r = await call('POST', '/api/shop/live/creator/videos', { phone: '77000000000', uploadId: 'abcdefgh12', total: 1, filename: 'a.mp4', contentType: 'video/mp4', title: 'x', skus: ['1'] });
    assert.equal(r.status, 403);
  });
});

describe('вкладки-категории Live', () => {
  test('админ создаёт вкладку с разделами каталога — ролики и эфиры попадают в неё по товарам', async () => {
    assert.equal((await call('POST', '/api/shop-admin/live/categories', { title: 'Красота', categories: ['Нет такого'] }, true)).status, 400);
    const c = await call('POST', '/api/shop-admin/live/categories', { title: 'Красота', categories: ['Красота и здоровье'], sort: 1 }, true);
    assert.equal(c.status, 201);
    videos.push({ id: 'v1', creatorId: 'cr1', title: 'Крем', videoUrl: 'https://p/v1.mp4', skus: '["1000001"]', status: 'published', likes: 0, views: 0, createdAt: new Date(Date.now() - 1000) });
    videos.push({ id: 'v2', creatorId: 'cr1', title: 'Сушилка', videoUrl: 'https://p/v2.mp4', skus: '["1000002"]', status: 'published', likes: 0, views: 0, createdAt: new Date() });
    const home = await call('GET', '/api/shop/live/home');
    assert.deepEqual(home.json.categories, [{ id: c.json.id, title: 'Красота', sections: ['Красота и здоровье'] }]);
    assert.deepEqual(home.json.shorts.find((v: Row) => v.id === 'v1').cats, [c.json.id]);
    assert.deepEqual(home.json.shorts.find((v: Row) => v.id === 'v2').cats, []);
    const feed = await call('GET', `/api/shop/live/shorts?cat=${c.json.id}`);
    assert.deepEqual(feed.json.items.map((v: Row) => v.id), ['v1']);
    assert.equal((await call('DELETE', `/api/shop-admin/live/categories/${c.json.id}`, undefined, true)).status, 200);
  });
});

describe('баннеры Live и колокольчик', () => {
  test('админ добавляет баннеры — они в /home по порядку, скрытые не видны', async () => {
    assert.equal((await call('POST', '/api/shop-admin/live/banners', { imageUrl: 'не ссылка' }, true)).status, 400);
    const a = await call('POST', '/api/shop-admin/live/banners', { imageUrl: 'https://cdn/b2.jpg', sort: 2, linkType: 'sku', linkValue: '1000001' }, true);
    assert.equal(a.status, 201);
    await call('POST', '/api/shop-admin/live/banners', { imageUrl: 'https://cdn/b1.jpg', sort: 1, title: 'Скидки' }, true);
    await call('POST', '/api/shop-admin/live/banners', { imageUrl: 'https://cdn/b3.jpg', sort: 3, active: false }, true);
    const h = await call('GET', '/api/shop/live/home');
    assert.deepEqual(h.json.banners.map((b: Row) => b.imageUrl), ['https://cdn/b1.jpg', 'https://cdn/b2.jpg']);
    assert.equal(h.json.banners[1].linkType, 'sku');
    assert.equal(h.json.banners[1].linkValue, '1000001');
    assert.equal((await call('DELETE', `/api/shop-admin/live/banners/${a.json.id}`, undefined, true)).status, 200);
    assert.equal((await call('GET', '/api/shop/live/home')).json.banners.length, 1);
  });

  test('🔔 подписка на креатора: видна в карточке эфира, снимается', async () => {
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Кухня', skus: ['1'] });
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/follow`, {})).status, 400);
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/follow`, { device: 'd1', pushToken: 'tok' })).json.following, true);
    assert.equal(follows.length, 1);
    assert.equal(follows[0].creatorId, 'cr1');
    let g = await call('GET', `/api/shop/live/streams/${r.json.id}?device=d1`);
    assert.equal(g.json.following, true);
    assert.equal(g.json.liked, false);
    await call('POST', `/api/shop/live/streams/${r.json.id}/follow`, { device: 'd1', follow: false });
    g = await call('GET', `/api/shop/live/streams/${r.json.id}?device=d1`);
    assert.equal(g.json.following, false);
  });
});

describe('Coupang: лайки пачкой, напоминание, топ-10', () => {
  test('♥ как в ТикТоке: count прибавляет столько лайков, сколько нажали (не больше 100 за раз)', async () => {
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Кухня', skus: ['1'] });
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/like`, { device: 'd1', count: 7 })).json.likes, 7);
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/like`, { device: 'd1', count: 5 })).json.likes, 12);
    assert.equal((await call('POST', `/api/shop/live/streams/${r.json.id}/like`, { device: 'd2', count: 999 })).json.likes, 112);
    assert.equal((await call('GET', `/api/shop/live/streams/${r.json.id}?device=d1`)).json.liked, true);
    videos.push({ id: 'v1', creatorId: 'cr1', title: 'Блендер', videoUrl: 'https://p/v1.mp4', skus: '["1"]', status: 'published', likes: 0, views: 0, createdAt: new Date() });
    assert.equal((await call('POST', '/api/shop/live/shorts/v1/like', { device: 'd1', count: 3 })).json.likes, 3);
  });

  test('🔔 «Напомнить» у анонса: сохраняется, видно в /home, снимается', async () => {
    streams.push({ id: 's1', creatorId: 'cr1', title: 'Анонс', channel: 'c1', status: 'scheduled', skus: '[]', scheduledAt: new Date(Date.now() + 3600_000), likes: 0, views: 0 });
    assert.equal((await call('POST', '/api/shop/live/streams/s1/remind', {})).status, 400);
    assert.equal((await call('POST', '/api/shop/live/streams/s1/remind', { device: 'd1', pushToken: 'tok' })).json.reminded, true);
    assert.deepEqual((await call('GET', '/api/shop/live/home?device=d1')).json.reminded, ['s1']);
    assert.deepEqual((await call('GET', '/api/shop/live/home?device=d2')).json.reminded, []);
    await call('POST', '/api/shop/live/streams/s1/remind', { device: 'd1', remind: false });
    assert.equal(reminders.length, 0);
  });

  test('Топ-10: по проданным штукам товаров за 7 дней, потом по просмотрам', async () => {
    streams.push({ id: 'r1', creatorId: 'cr1', title: 'Повтор 1', channel: 'c1', status: 'ended', replayUrl: 'https://p/1.mp4', skus: '["A"]', endedAt: new Date(), likes: 0, views: 50 });
    streams.push({ id: 'r2', creatorId: 'cr1', title: 'Повтор 2', channel: 'c2', status: 'ended', replayUrl: 'https://p/2.mp4', skus: '["B"]', endedAt: new Date(), likes: 0, views: 5 });
    videos.push({ id: 'v1', creatorId: 'cr1', title: 'Ролик', videoUrl: 'https://p/v.mp4', skus: '["C"]', status: 'published', likes: 0, views: 0, createdAt: new Date() });
    orders.push({ items: JSON.stringify([{ sku: 'B', quantity: 3 }, { sku: 'C', quantity: 1 }]) });
    const h = await call('GET', '/api/shop/live/home');
    assert.deepEqual(h.json.top, [
      { kind: 'stream', id: 'r2', sold: 3 },
      { kind: 'short', id: 'v1', sold: 1 },
      { kind: 'stream', id: 'r1', sold: 0 },
    ]);
  });
});

describe('ТикТок: события чата, ♥ счётчик, подарки креатору', () => {
  test('вход, лайки и «поделился» появляются в чате; ♥ эфира видно в чате', async () => {
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Яблоки', skus: ['1'] });
    await call('POST', `/api/shop/live/streams/${r.json.id}/join`, { device: 'd1', name: 'Аслан' });
    await call('POST', `/api/shop/live/streams/${r.json.id}/join`, { device: 'd1', name: 'Аслан' }); // повтор не пишем
    await call('POST', `/api/shop/live/streams/${r.json.id}/like`, { device: 'd1', count: 80, name: 'Аслан' });
    await call('POST', `/api/shop/live/streams/${r.json.id}/share`, { device: 'd1', name: 'Аслан' });
    const c = await call('GET', `/api/shop/live/streams/${r.json.id}/chat?after=0`);
    assert.deepEqual(c.json.messages.map((m: Row) => [m.kind, m.text]), [
      ['join', 'теперь с нами'],
      ['like', 'отправил(а) лайки (80 шт.)'],
      ['share', 'поделился(-ась) трансляцией'],
    ]);
    assert.equal(c.json.likes, 80);
  });

  test('подарки: набор по умолчанию, 100 бесплатных монет в день, подарок идёт креатору и виден в чате и топе', async () => {
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Яблоки', skus: ['1'] });
    const list = await call('GET', '/api/shop/live/gifts?device=d1');
    assert.ok(list.json.items.length >= 10, JSON.stringify(list.json));
    assert.equal(list.json.coins, 100);
    const rose = list.json.items.find((g: Row) => g.title === 'Роза');
    const rocket = list.json.items.find((g: Row) => g.title === 'Ракета');
    const sent = await call('POST', `/api/shop/live/streams/${r.json.id}/gift`, { device: 'd1', name: 'Аслан', giftId: rose.id, count: 3 });
    assert.equal(sent.json.coins, 97);
    const tooMuch = await call('POST', `/api/shop/live/streams/${r.json.id}/gift`, { device: 'd1', name: 'Аслан', giftId: rocket.id });
    assert.equal(tooMuch.status, 402);
    assert.equal(giftSends[0].creatorId, 'cr1');
    const c = await call('GET', `/api/shop/live/streams/${r.json.id}/chat?after=0`);
    const ev = c.json.messages.find((m: Row) => m.kind === 'gift');
    assert.equal(ev.meta.emoji, '🌹');
    assert.equal(ev.meta.count, 3);
    assert.deepEqual(c.json.topGifters, [{ name: 'Аслан', coins: 3 }]);
    const s = await call('GET', `/api/shop/live/streams/${r.json.id}`);
    assert.equal(s.json.creatorGiftCoins, 3);
    const mine = await call('GET', `/api/shop/live/creator/mine?phone=${PHONE}`);
    assert.equal(mine.json.profile.giftCoins, 3);
  });

  test('подарок вне эфира не отправляется', async () => {
    streams.push({ id: 's9', creatorId: 'cr1', title: 'Анонс', channel: 'c9', status: 'scheduled', skus: '[]', likes: 0, views: 0 });
    const list = await call('GET', '/api/shop/live/gifts?device=d1');
    const r = await call('POST', '/api/shop/live/streams/s9/gift', { device: 'd1', giftId: list.json.items[0].id });
    assert.equal(r.status, 409);
  });
});

describe('Креаторы: топ, страница, подписка', () => {
  test('топ креаторов: раздел по товарам, «Рекомендовать» первым, подписка видна', async () => {
    creators.push({ id: 'cr2', phone: '77000000002', name: 'Данияр', code: 'MM-2', percent: 7, active: true, featured: false });
    videos.push({ id: 'v1', creatorId: 'cr1', title: 'Крем', videoUrl: 'https://p/v1.mp4', skus: '["1000001"]', status: 'published', likes: 5, views: 0, createdAt: new Date() });
    videos.push({ id: 'v2', creatorId: 'cr2', title: 'Сушилка', videoUrl: 'https://p/v2.mp4', skus: '["1000002"]', status: 'published', likes: 1, views: 0, createdAt: new Date() });
    let r = await call('GET', '/api/shop/live/creators?device=d1');
    assert.deepEqual(r.json.items.map((c: Row) => [c.name, c.category]), [['Айгерим', 'Красота и здоровье'], ['Данияр', 'Дом и сад']]);
    await call('POST', '/api/shop/live/creators/cr2/follow', { device: 'd1' });
    creators[1].featured = true;
    r = await call('GET', '/api/shop/live/creators?device=d1');
    assert.equal(r.json.items[0].name, 'Данияр');
    assert.equal(r.json.items[0].following, true);
    assert.equal(r.json.items[0].followers, 1);
    const page = await call('GET', '/api/shop/live/creators/cr2?device=d1');
    assert.equal(page.json.creator.name, 'Данияр');
    assert.deepEqual(page.json.shorts.map((v: Row) => v.id), ['v2']);
    assert.deepEqual(page.json.skus, ['1000002']);
    assert.equal(page.json.shorts[0].creatorId, 'cr2');
    assert.equal((await call('GET', '/api/shop/live/creators/nope')).status, 404);
  });
});

describe('Админка: удалить повтор эфира', () => {
  test('повтор пропадает из приложения и не возвращается; идущий эфир не трогаем', async () => {
    streams.push({ id: 'r1', creatorId: 'cr1', title: 'Повтор', channel: 'c1', status: 'ended', replayUrl: 'https://p/1.mp4', recState: 'stopped', skus: '[]', endedAt: new Date(), likes: 0, views: 3 });
    const r = await call('DELETE', '/api/shop-admin/live/streams/r1/replay', undefined, true);
    assert.equal(r.status, 200);
    assert.equal(streams[0].replayUrl, null);
    assert.equal(streams[0].recState, 'deleted');
    assert.deepEqual((await call('GET', '/api/shop/live/home')).json.replays, []);
    const live = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Идёт', skus: ['1'] });
    assert.equal((await call('DELETE', `/api/shop-admin/live/streams/${live.json.id}/replay`, undefined, true)).status, 409);
  });
});

describe('Срок хранения повтора', () => {
  test('выбрал 7 дней — через 7 дней повтор удаляется сам', async () => {
    streams.push({ id: 'r1', creatorId: 'cr1', title: 'Повтор', channel: 'c1', status: 'ended', replayUrl: 'https://p/1.mp4', recState: 'stopped', skus: '[]', endedAt: new Date(), likes: 0, views: 0 });
    const r = await call('PATCH', '/api/shop-admin/live/streams/r1/replay', { days: 7 }, true);
    assert.equal(r.status, 200);
    const until = new Date(streams[0].replayUntil).getTime();
    assert.ok(Math.abs(until - (Date.now() + 7 * 86400_000)) < 60_000);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { purgeExpiredReplays } = require('../src/services/live.service');
    assert.equal(await purgeExpiredReplays(10, Date.now() + 6 * 86400_000), 0);
    assert.equal(await purgeExpiredReplays(10, Date.now() + 8 * 86400_000), 1);
    assert.equal(streams[0].replayUrl, null);
    assert.equal((await call('PATCH', '/api/shop-admin/live/streams/r1/replay', { days: 400 }, true)).status, 400);
  });
});
