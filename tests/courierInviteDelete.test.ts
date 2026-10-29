/**
 * «Курьеры» → «Вакансия»: список вакансий и удаление (DELETE /api/shop-admin/courier-invites/:phone).
 * Удаление стирает invite и связанную НЕодобренную заявку; одобренного/зарегистрированного курьера не трогает.
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

const matches = (x: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(x[k]);
    if (v && typeof v === 'object' && 'not' in v) return x[k] !== v.not;
    return x[k] === v;
  });

const stub: Row = {
  shopCourierInvite: {
    findMany: async () => invites.map((x) => ({ ...x })),
    deleteMany: async (a: Row) => {
      const before = invites.length;
      invites = invites.filter((x) => !matches(x, a.where));
      return { count: before - invites.length };
    },
  },
  shopCourierApplication: {
    findMany: async (a: Row) => apps.filter((x) => matches(x, a.where)).map((x) => ({ ...x })),
    findUnique: async (a: Row) => { const x = apps.find((r) => matches(r, a.where)); return x ? { ...x } : null; },
    deleteMany: async (a: Row) => {
      const before = apps.length;
      apps = apps.filter((x) => !matches(x, a.where));
      return { count: before - apps.length };
    },
  },
  courier: {
    findUnique: async (a: Row) => { const x = couriers.find((r) => matches(r, a.where)); return x ? { ...x } : null; },
  },
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
const AUTH = { authorization: 'Basic ' + Buffer.from(`admin-test:${process.env.ADMIN_PASSWORD}`).toString('base64'), 'sec-fetch-site': 'same-origin' };
function call(method: string, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: AUTH }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* не JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}
before(async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port; });
after(() => new Promise<void>((r) => server.close(() => r())));

const invite = (o: Row = {}): Row => ({ phone: '77011112233', firstName: 'Али', lastName: 'Ким', iin: '900101300123', createdAt: new Date('2026-10-01'), ...o });
const application = (o: Row = {}): Row => ({ id: 'a1', phone: '77011112233', name: 'Али Ким', city: 'Алматы', iin: '900101300123', status: 'rejected', archived: true, createdAt: new Date('2026-10-02'), reviewedAt: null, ...o });
beforeEach(() => { invites = []; apps = []; couriers = []; });

describe('GET /api/shop-admin/courier-invites', () => {
  test('отдаёт вакансии со статусом связанной заявки (null, если заявки нет)', async () => {
    invites = [invite(), invite({ phone: '77014445566', firstName: 'Ая', lastName: 'Н' })];
    apps = [application()];
    const r = await call('GET', '/api/shop-admin/courier-invites');
    assert.equal(r.status, 200);
    const byPhone = Object.fromEntries(r.json.map((i: Row) => [i.phone, i.applicationStatus]));
    assert.deepEqual(byPhone, { '77011112233': 'rejected', '77014445566': null });
  });
});

describe('DELETE /api/shop-admin/courier-invites/:phone', () => {
  test('стирает вакансию И отклонённую заявку — номер чистый', async () => {
    invites = [invite()];
    apps = [application()];
    const r = await call('DELETE', '/api/shop-admin/courier-invites/%2B7%20701%20111-22-33'); // формат записи не важен
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, invitesDeleted: 1, applicationsDeleted: 1 });
    assert.equal(invites.length, 0);
    assert.equal(apps.length, 0);
  });

  test('вакансия без заявки удаляется, чужие записи не задеваются', async () => {
    invites = [invite(), invite({ phone: '77014445566' })];
    apps = [application({ id: 'a2', phone: '77014445566', status: 'pending', archived: false })];
    const r = await call('DELETE', '/api/shop-admin/courier-invites/77011112233');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, invitesDeleted: 1, applicationsDeleted: 0 });
    assert.deepEqual(invites.map((i) => i.phone), ['77014445566']);
    assert.equal(apps.length, 1);
  });

  test('архивная заявка без вакансии (старая) тоже удаляется', async () => {
    apps = [application()];
    const r = await call('DELETE', '/api/shop-admin/courier-invites/77011112233');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, invitesDeleted: 0, applicationsDeleted: 1 });
  });

  test('одобренная заявка → 409, ничего не удалено', async () => {
    invites = [invite()];
    apps = [application({ status: 'approved', archived: false })];
    const r = await call('DELETE', '/api/shop-admin/courier-invites/77011112233');
    assert.equal(r.status, 409);
    assert.equal(invites.length, 1);
    assert.equal(apps.length, 1);
  });

  test('курьер уже зарегистрирован → 409, ничего не удалено', async () => {
    invites = [invite()];
    apps = [application({ status: 'rejected' })];
    couriers = [{ id: 'c1', phone: '77011112233' }];
    const r = await call('DELETE', '/api/shop-admin/courier-invites/77011112233');
    assert.equal(r.status, 409);
    assert.equal(invites.length, 1);
    assert.equal(apps.length, 1);
    assert.equal(couriers.length, 1);
  });

  test('нет ни вакансии, ни заявки → 404; кривой телефон → 400', async () => {
    assert.equal((await call('DELETE', '/api/shop-admin/courier-invites/77011112233')).status, 404);
    assert.equal((await call('DELETE', '/api/shop-admin/courier-invites/123')).status, 400);
  });
});
