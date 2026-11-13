/** Закупки у оптовиков: добавить, изменить, удалить, итоги за период/всё время/по оптовикам. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = randomBytes(8).toString('hex');
process.env.ADMIN_USER = 'admin-test';
process.env.ADMIN_PASSWORD = randomBytes(12).toString('hex');

type Row = Record<string, any>;
const rows: Row[] = [];
let seq = 0;
const inRange = (r: Row, w: Row) => !w.date || ((!w.date.gte || r.date >= w.date.gte) && (!w.date.lte || r.date <= w.date.lte));
class StubPrismaClient {
  constructor() {
    const stub: Row = {
      wholesalerPurchase: {
        findMany: async (a: Row) => rows.filter((r) => inRange(r, a.where ?? {})).sort((x, y) => (x.date < y.date ? 1 : -1)),
        aggregate: async () => ({ _sum: { amount: rows.reduce((s, r) => s + r.amount, 0) } }),
        create: async (a: Row) => { const r = { id: `p${++seq}`, createdAt: new Date(), ...a.data }; rows.push(r); return r; },
        update: async (a: Row) => { const r = rows.find((x) => x.id === a.where.id); if (!r) { const e: any = new Error('nf'); e.code = 'P2025'; throw e; } Object.assign(r, a.data); return r; },
        delete: async (a: Row) => { const i = rows.findIndex((x) => x.id === a.where.id); if (i < 0) { const e: any = new Error('nf'); e.code = 'P2025'; throw e; } return rows.splice(i, 1)[0]; },
      },
    };
    return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; return stub[key as string] ?? new Proxy({}, { get: () => async () => [] }); } });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;

let port = 0;
let server: http.Server;
function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)),
      authorization: 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString('base64'),
    } }, (res) => { const c: Buffer[] = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(c).toString() || 'null') })); });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}
before(async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port; });
after(() => new Promise<void>((r) => server.close(() => r())));

describe('Закупки у оптовиков', () => {
  test('добавить, итоги за период, всё время и по оптовикам', async () => {
    assert.equal((await call('POST', '/api/wholesalers/purchases', { amount: 150000, wholesalerId: 'w1', note: '10 кофеварок', date: '2026-11-13' })).status, 201);
    await call('POST', '/api/wholesalers/purchases', { amount: 85500, wholesalerId: 'w2', date: '2026-11-10' });
    await call('POST', '/api/wholesalers/purchases', { amount: 20000, date: '2026-10-05' });
    const nov = await call('GET', '/api/wholesalers/purchases?from=2026-11-01&to=2026-11-30');
    assert.equal(nov.json.totalPeriod, 235500);
    assert.equal(nov.json.totalAll, 255500);
    assert.deepEqual(nov.json.byWholesaler, { w1: 150000, w2: 85500 });
    const oct = await call('GET', '/api/wholesalers/purchases?from=2026-10-01&to=2026-10-31');
    assert.deepEqual(oct.json.byWholesaler, { __general__: 20000 });
  });

  test('изменить и удалить', async () => {
    const id = rows[0].id;
    assert.equal((await call('PUT', `/api/wholesalers/purchases/${id}`, { amount: 160000, wholesalerId: 'w1', note: '11 кофеварок' })).status, 200);
    assert.equal(rows[0].amount, 160000);
    assert.equal((await call('DELETE', `/api/wholesalers/purchases/${id}`)).status, 200);
    assert.equal(rows.find((r) => r.id === id), undefined);
    assert.equal((await call('DELETE', `/api/wholesalers/purchases/${id}`)).status, 404);
  });

  test('сумма должна быть больше 0', async () => {
    assert.equal((await call('POST', '/api/wholesalers/purchases', { amount: 0 })).status, 400);
    assert.equal((await call('POST', '/api/wholesalers/purchases', { amount: 100, date: '13.11.2026' })).status, 400);
  });
});
