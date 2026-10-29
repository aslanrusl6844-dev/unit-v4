/**
 * «Курьеры»: одобренная заявка сразу видна в списке «Активные» (GET /api/shop-admin/couriers),
 * пока курьер не прошёл регистрацию в приложении; после регистрации — обычная строка с данными.
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
let couriers: Row[] = [];
let apps: Row[] = [];
const stub: Row = {
  courier: { findMany: async () => couriers.map((c) => ({ ...c })) },
  courierPayout: { groupBy: async () => [] },
  shopCourierApplication: {
    findUnique: async (a: Row) => { const x = apps.find((r) => r.id === a.where.id); return x ? { ...x } : null; },
    findMany: async (a: Row) => apps.filter((x) => Object.entries(a.where ?? {}).every(([k, v]) => x[k] === v)).map((x) => ({ ...x })),
    update: async (a: Row) => {
      const x = apps.find((r) => r.id === a.where.id);
      if (!x) throw Object.assign(new Error('nf'), { code: 'P2025' });
      Object.assign(x, a.data);
      return { ...x };
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

const application = (o: Row = {}): Row => ({ id: 'a1', phone: '77011112233', name: 'Али Ким', city: 'Алматы', iin: '900101300123', status: 'pending', archived: false, createdAt: new Date('2026-10-01'), reviewedAt: null, ...o });
beforeEach(() => { couriers = []; apps = []; });

describe('GET /api/shop-admin/couriers — одобренные заявки в «Активных»', () => {
  test('после «Одобрить» курьер сразу в списке: активен, ждёт регистрации, с именем/телефоном/ИИН', async () => {
    apps = [application()];
    assert.deepEqual((await call('GET', '/api/shop-admin/couriers')).json, []); // заявка ещё не одобрена
    const ap = await call('POST', '/api/shop-admin/courier-applications/a1/approve');
    assert.equal(ap.status, 200);
    const r = await call('GET', '/api/shop-admin/couriers');
    assert.equal(r.json.length, 1);
    const c = r.json[0];
    assert.equal(c.pendingRegistration, true);
    assert.equal(c.active, true);
    assert.equal(c.name, 'Али Ким');
    assert.equal(c.phone, '77011112233');
    assert.equal(c.iin, '900101300123');
    assert.equal(c.city, 'Алматы');
    assert.equal(c.id, 'app:a1');
    assert.equal(c.requisitesValue, null);
  });

  test('отклонённые и архивные заявки в «Активные» не попадают', async () => {
    apps = [application({ id: 'a2', status: 'rejected', archived: true }), application({ id: 'a3', status: 'approved', archived: true, phone: '77012223344' }), application({ id: 'a4', status: 'pending', phone: '77013334455' })];
    assert.deepEqual((await call('GET', '/api/shop-admin/couriers')).json, []);
  });

  test('курьер уже зарегистрировался → одна обычная строка с фото/адресом/авто/реквизитами, без дубля из заявки', async () => {
    apps = [application({ status: 'approved' })];
    couriers = [{ id: 'c1', name: 'Али Ким', phone: '77011112233', requisitesType: 'kaspi', requisitesValue: '77011112233', active: true, createdAt: new Date(), iin: '900101300123', address: 'ул. Абая 1', vehicle: 'Toyota 123', idPhotoUrl: 'https://x/id.jpg', facePhotoUrl: 'https://x/f.jpg', agreeContractAt: new Date() }];
    const r = await call('GET', '/api/shop-admin/couriers');
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].id, 'c1');
    assert.equal(r.json[0].pendingRegistration, undefined);
    assert.equal(r.json[0].vehicle, 'Toyota 123');
    assert.equal(r.json[0].facePhotoUrl, 'https://x/f.jpg');
  });

  test('ждущие регистрации идут первыми, заблокированные зарегистрированные остаются заблокированными', async () => {
    apps = [application({ status: 'approved' })];
    couriers = [{ id: 'c9', name: 'Блок', phone: '77019998877', requisitesType: 'card', requisitesValue: '4000', active: false, createdAt: new Date() }];
    const r = await call('GET', '/api/shop-admin/couriers');
    assert.deepEqual(r.json.map((c: Row) => [c.id, c.active]), [['app:a1', true], ['c9', false]]);
  });
});
