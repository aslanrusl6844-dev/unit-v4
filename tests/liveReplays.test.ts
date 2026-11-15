/**
 * Повторы эфиров: облачная запись Agora → R2. Agora REST — заглушка.
 * (Ниже — та же заглушка БД, что в live.test.ts.)
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
process.env.AGORA_CUSTOMER_ID = 'cust';
process.env.AGORA_CUSTOMER_SECRET = 'secret';
process.env.R2_ACCOUNT_ID = 'acc123';
process.env.R2_ACCESS_KEY_ID = 'ak';
process.env.R2_SECRET_ACCESS_KEY = 'sk';
process.env.R2_PUBLIC_URL = 'https://pub-test.r2.dev';

type Row = Record<string, any>;
let creators: Row[] = [];
let streams: Row[] = [];
let videos: Row[] = [];
let likes: Row[] = [];
let chat: Row[] = [];
let liveCats: Row[] = [];
const products: Row[] = [
  { sku: 'ozon-1', shopArticle: '1000001', category: 'Красота и здоровье' },
  { sku: 'ozon-2', shopArticle: '1000002', category: 'Дом и сад' },
];
let seq = 0;

const match = (x: Row, w: Row = {}): boolean => Object.entries(w).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(x[k]);
    if ('not' in v) return x[k] !== v.not;
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
  streams = []; videos = []; likes = []; chat = []; liveCats = []; seq = 0;
});


// eslint-disable-next-line @typescript-eslint/no-var-requires
const live = require('../src/services/live.service');
const agoraCalls: Row[] = [];
live.setRecordingFetch(async (url: string, init: Row) => {
  const body = JSON.parse(init.body);
  agoraCalls.push({ url, body, auth: init.headers.authorization });
  if (url.endsWith('/acquire')) return new Response(JSON.stringify({ resourceId: 'RES1' }), { status: 200 });
  if (url.includes('/start')) return new Response(JSON.stringify({ sid: 'SID1' }), { status: 200 });
  if (url.includes('/stop')) return new Response(JSON.stringify({ serverResponse: { fileList: [{ fileName: 'live/' + body.cname + '/SID1_x.m3u8' }, { fileName: 'live/abc/SID1_x_0.mp4' }] } }), { status: 200 });
  return new Response('{}', { status: 404 });
});

describe('повторы эфиров', () => {
  test('старт эфира запускает запись в R2, стоп — сохраняет ссылку на mp4, повтор виден на главной Live', async () => {
    const r = await call('POST', '/api/shop/live/creator/streams/start', { phone: PHONE, title: 'Кухня', skus: ['1000001'] });
    assert.equal(r.status, 200);
    for (let i = 0; i < 20 && streams[0].recState !== 'recording'; i += 1) await new Promise((res) => setTimeout(res, 20));
    assert.equal(streams[0].recState, 'recording');
    const start = agoraCalls.find((c) => c.url.includes('/start'))!;
    assert.match(start.auth, /^Basic /);
    assert.equal(start.body.clientRequest.storageConfig.vendor, 11);
    assert.equal(start.body.clientRequest.storageConfig.extensionParams.endpoint, 'https://acc123.r2.cloudflarestorage.com');
    assert.deepEqual(start.body.clientRequest.storageConfig.fileNamePrefix, ['live', r.json.id.replace(/[^a-zA-Z0-9]/g, '')]);
    await call('POST', `/api/shop/live/creator/streams/${r.json.id}/stop`, { phone: PHONE });
    assert.equal(streams[0].replayUrl, 'https://pub-test.r2.dev/live/abc/SID1_x_0.mp4');
    const home = await call('GET', '/api/shop/live/home');
    assert.equal(home.json.replays.length, 1);
    assert.equal(home.json.replays[0].replayUrl, 'https://pub-test.r2.dev/live/abc/SID1_x_0.mp4');
  });
});
