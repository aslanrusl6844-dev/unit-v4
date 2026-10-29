/**
 * «Курьеры»: массовая очистка.
 *  - POST /courier-applications/bulk-delete — выбранные заявки из «Архива» + их вакансии;
 *  - POST /couriers/bulk-delete — курьер + заявка + вакансия по телефону; с заказами/выплатами — пропускается.
 * Невыбранные записи (в т.ч. свежие «Ожидает») не затрагиваются.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = randomBytes(8).toString('hex');
process.env.ADMIN_USER = 'admin-test';
process.env.ADMIN_PASSWORD = randomBytes(12).toString('hex');

type Row = Record<string, any>;
let invites: Row[] = [];
let apps: Row[] = [];
let couriers: Row[] = [];
let orders: Row[] = [];
let payouts: Row[] = [];

const matches = (x: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(x[k]);
    if (v && typeof v === 'object' && 'not' in v) return x[k] !== v.not;
    return x[k] === v;
  });
const del = (list: Row[], where: Row) => { const keep = list.filter((x) => !matches(x, where)); const count = list.length - keep.length; return { keep, count }; };
const groupCount = (list: Row[], where: Row) => {
  const m = new Map<string, number>();
  for (const x of list.filter((r) => matches(r, where))) m.set(x.courierId, (m.get(x.courierId) ?? 0) + 1);
  return [...m].map(([courierId, n]) => ({ courierId, _count: { id: n } }));
};

const stub: Row = {
  shopCourierInvite: {
    deleteMany: async (a: Row) => { const r = del(invites, a.where); invites = r.keep; return { count: r.count }; },
  },
  shopCourierApplication: {
    findMany: async (a: Row) => apps.filter((x) => matches(x, a.where)).map((x) => ({ ...x })),
    deleteMany: async (a: Row) => { const r = del(apps, a.where); apps = r.keep; return { count: r.count }; },
  },
  courier: {
    findMany: async (a: Row) => couriers.filter((x) => matches(x, a.where)).map((x) => ({ ...x })),
    deleteMany: async (a: Row) => { const r = del(couriers, a.where); couriers = r.keep; return { count: r.count }; },
  },
  shopOrder: { groupBy: async (a: Row) => groupCount(orders, a.where) },
  courierPayout: { groupBy: async (a: Row) => groupCount(payouts, a.where) },
  $transaction: async (ops: Array<Promise<any>>) => Promise.all(ops),
};
class StubPrismaClient {
  constructor() {
    return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; if (key in stub) return stub[key as string]; return new Proxy({}, { get: () => async () => [] }); } });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;

let port = 0;
let server: http.Server;
const AUTH = { authorization: 'Basic ' + Buffer.from(`admin-test:${process.env.ADMIN_PASSWORD}`).toString('base64'), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: AUTH }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* не JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
}
before(async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port; });
after(() => new Promise<void>((r) => server.close(() => r())));

const invite = (phone: string): Row => ({ phone, firstName: 'А', lastName: 'Б', iin: '900101300123', createdAt: new Date('2026-10-01') });
const application = (id: string, phone: string, o: Row = {}): Row => ({ id, phone, name: 'Али Ким', city: 'Алматы', iin: '900101300123', status: 'rejected', archived: true, createdAt: new Date('2026-10-02'), reviewedAt: null, ...o });
const courier = (id: string, phone: string, o: Row = {}): Row => ({ id, phone, name: 'Курьер ' + id, active: true, ...o });
beforeEach(() => { invites = []; apps = []; couriers = []; orders = []; payouts = []; });

describe('POST /api/shop-admin/courier-applications/bulk-delete', () => {
  test('удаляет выбранные заявки и их вакансии; невыбранные (в т.ч. «Ожидает») остаются', async () => {
    invites = [invite('77011111111'), invite('77012222222'), invite('77013333333')];
    apps = [
      application('a1', '77011111111'),
      application('a2', '77012222222', { status: 'approved' }),
      application('a3', '77013333333', { status: 'pending', archived: false }),
    ];
    const r = await post('/api/shop-admin/courier-applications/bulk-delete', { ids: ['a1', 'a2'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, deleted: 2, invitesDeleted: 2 });
    assert.deepEqual(apps.map((a) => a.id), ['a3']);
    assert.deepEqual(invites.map((i) => i.phone), ['77013333333']);
  });

  test('строки Courier не трогаются; пустой/левый список — 0 удалённых; пустой ids — 400', async () => {
    couriers = [courier('c1', '77011111111')];
    apps = [application('a1', '77011111111', { status: 'approved' })];
    assert.equal((await post('/api/shop-admin/courier-applications/bulk-delete', { ids: ['a1'] })).status, 200);
    assert.equal(couriers.length, 1);
    assert.deepEqual((await post('/api/shop-admin/courier-applications/bulk-delete', { ids: ['nope'] })).json, { ok: true, deleted: 0, invitesDeleted: 0 });
    assert.equal((await post('/api/shop-admin/courier-applications/bulk-delete', { ids: [] })).status, 400);
  });
});

describe('POST /api/shop-admin/couriers/bulk-delete', () => {
  test('удаляет курьера (активного и заблокированного), заявку и вакансию — телефон чистый', async () => {
    couriers = [courier('c1', '77011111111'), courier('c2', '77012222222', { active: false }), courier('c3', '77019999999')];
    apps = [application('a1', '77011111111', { status: 'approved', archived: false }), application('a2', '77012222222', { status: 'approved' }), application('a9', '77019999999', { status: 'pending', archived: false })];
    invites = [invite('77011111111'), invite('77012222222'), invite('77019999999')];
    const r = await post('/api/shop-admin/couriers/bulk-delete', { ids: ['c1', 'c2'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, deleted: 2, skipped: [] });
    assert.deepEqual(couriers.map((c) => c.id), ['c3']);
    assert.deepEqual(apps.map((a) => a.id), ['a9']); // свежая «Ожидает» не выбрана — осталась
    assert.deepEqual(invites.map((i) => i.phone), ['77019999999']);
  });

  test('курьер с заказами или выплатами пропускается и возвращается в skipped; остальные удаляются', async () => {
    couriers = [courier('c1', '77011111111'), courier('c2', '77012222222'), courier('c3', '77013333333')];
    apps = [application('a1', '77011111111', { status: 'approved' }), application('a2', '77012222222', { status: 'approved' }), application('a3', '77013333333', { status: 'approved' })];
    invites = [invite('77011111111'), invite('77012222222'), invite('77013333333')];
    orders = [{ id: 'o1', courierId: 'c1' }];
    payouts = [{ id: 'p1', courierId: 'c2' }];
    const r = await post('/api/shop-admin/couriers/bulk-delete', { ids: ['c1', 'c2', 'c3'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.deleted, 1);
    assert.deepEqual(r.json.skipped.map((s: Row) => s.id).sort(), ['c1', 'c2']);
    assert.deepEqual(couriers.map((c) => c.id).sort(), ['c1', 'c2']);
    assert.deepEqual(apps.map((a) => a.id).sort(), ['a1', 'a2']); // у пропущенных заявка и вакансия тоже целы
    assert.deepEqual(invites.map((i) => i.phone).sort(), ['77011111111', '77012222222']);
  });

  test('«app:<id>» — одобренный, ещё не зарегистрированный: чистятся заявка и вакансия', async () => {
    apps = [application('a1', '77011111111', { status: 'approved', archived: false })];
    invites = [invite('77011111111')];
    const r = await post('/api/shop-admin/couriers/bulk-delete', { ids: ['app:a1'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, deleted: 1, skipped: [] });
    assert.equal(apps.length, 0);
    assert.equal(invites.length, 0);
  });

  test('пустой ids — 400', async () => {
    assert.equal((await post('/api/shop-admin/couriers/bulk-delete', { ids: [] })).status, 400);
  });
});
