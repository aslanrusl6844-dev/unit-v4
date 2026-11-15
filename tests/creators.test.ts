/**
 * Креаторы My Market Live (шаг 1): заявка из приложения, статус, одобрение с процентом и кодом,
 * отказ, процент и выключение в админке. БД — заглушка в памяти.
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

type Row = Record<string, any>;
let apps: Row[] = [];
let creators: Row[] = [];
let seq = 0;

const stub: Record<string, any> = {
  creatorApplication: {
    findUnique: async (a: Row) => apps.find((x) => (a.where.id ? x.id === a.where.id : x.phone === a.where.phone)) ?? null,
    findMany: async (a: Row) => apps.filter((x) => !a.where?.status || x.status === a.where.status),
    create: async (a: Row) => { const r = { id: `a${++seq}`, createdAt: new Date(), ...a.data }; apps.push(r); return { ...r }; },
    update: async (a: Row) => {
      const r = apps.find((x) => (a.where.id ? x.id === a.where.id : x.phone === a.where.phone));
      if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
      Object.assign(r, a.data);
      return { ...r };
    },
  },
  creator: {
    findUnique: async (a: Row) => creators.find((x) => (a.where.id ? x.id === a.where.id : a.where.code ? x.code === a.where.code : x.phone === a.where.phone)) ?? null,
    findMany: async () => creators,
    create: async (a: Row) => { const r = { id: `c${++seq}`, createdAt: new Date(), ...a.data }; creators.push(r); return { ...r }; },
    update: async (a: Row) => {
      const r = creators.find((x) => x.id === a.where.id);
      if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
      Object.assign(r, a.data);
      return { ...r };
    },
    updateMany: async (a: Row) => { let n = 0; creators.forEach((c) => { if (c.phone === a.where.phone) { Object.assign(c, a.data); n += 1; } }); return { count: n }; },
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
const PHONE = '+7 701 111 22 33';
const apply = (extra: Row = {}) => call('POST', '/api/shop/creator/apply', {
  phone: PHONE, name: 'Айгерим', city: 'Алматы',
  answers: { format: 'оба', followers: 'до 1 000', interests: ['дом', 'дети'], motivation: 'Хочу зарабатывать в декрете' },
  trialVideoUrl: 'https://pub-x.r2.dev/trial.mp4',
  consentPersonalData: true, consentRules: true, adult: true,
  ...extra,
});

before(async () => { server = app.listen(0); port = (server.address() as any).port; });
after(() => server.close());
beforeEach(() => { apps = []; creators = []; seq = 0; });

describe('креаторы', () => {
  test('заявка без согласий не принимается; с согласиями — pending', async () => {
    assert.equal((await apply({ adult: false })).status, 400);
    const r = await apply();
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'pending');
    assert.equal(apps[0].phone, '77011112233');
    assert.equal(JSON.parse(apps[0].answers).format, 'оба');
    assert.equal((await call('GET', `/api/shop/creator/me?phone=${encodeURIComponent(PHONE)}`)).json.status, 'pending');
  });

  test('без x-app-key — нельзя; админка без входа — нельзя', async () => {
    const r = await new Promise<number>((resolve) => {
      const q = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/shop/creator/me?phone=77011112233' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      q.end();
    });
    assert.equal(r, 401);
    assert.equal((await call('GET', '/api/shop-admin/creators/applications')).status, 401);
  });

  test('одобрение с процентом: креатор с кодом MM-XXXXX, в приложении — код и процент', async () => {
    await apply();
    const list = await call('GET', '/api/shop-admin/creators/applications?status=pending', undefined, true);
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].answers.motivation, 'Хочу зарабатывать в декрете');
    assert.equal((await call('POST', `/api/shop-admin/creators/applications/${apps[0].id}/approve`, { percent: 80 }, true)).status, 400);
    const ok = await call('POST', `/api/shop-admin/creators/applications/${apps[0].id}/approve`, { percent: 7.5 }, true);
    assert.equal(ok.status, 200);
    assert.match(ok.json.code, /^MM-[A-Z2-9]{5}$/);
    assert.equal(ok.json.percent, 7.5);
    const me = await call('GET', `/api/shop/creator/me?phone=${encodeURIComponent(PHONE)}`);
    assert.deepEqual(me.json, { status: 'approved', creator: { code: ok.json.code, percent: 7.5, name: 'Айгерим' } });
    // Повторная заявка решения не меняет.
    assert.equal((await apply()).json.status, 'approved');
  });

  test('процент меняется, выключенный креатор — blocked', async () => {
    await apply();
    const c = (await call('POST', `/api/shop-admin/creators/applications/${apps[0].id}/approve`, { percent: 7 }, true)).json;
    assert.equal((await call('PATCH', `/api/shop-admin/creators/${c.id}`, { percent: 10 }, true)).json.percent, 10);
    await call('PATCH', `/api/shop-admin/creators/${c.id}`, { active: false }, true);
    assert.equal((await call('GET', `/api/shop/creator/me?phone=${encodeURIComponent(PHONE)}`)).json.status, 'blocked');
  });

  test('отказ с причиной и возврат в заявки', async () => {
    await apply();
    const r = await call('POST', `/api/shop-admin/creators/applications/${apps[0].id}/reject`, { reason: 'Нет видео' }, true);
    assert.equal(r.json.status, 'rejected');
    assert.equal((await call('GET', `/api/shop/creator/me?phone=${encodeURIComponent(PHONE)}`)).json.status, 'rejected');
    await call('POST', `/api/shop-admin/creators/applications/${apps[0].id}/reopen`, {}, true);
    assert.equal(apps[0].status, 'pending');
  });
});
