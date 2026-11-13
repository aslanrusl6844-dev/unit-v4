/** Админка → цена на Ozon: проверки, отправка на Ozon, запись цены продажи для юнит-экономики. */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = randomBytes(8).toString('hex');
process.env.ADMIN_USER = 'admin-test';
process.env.ADMIN_PASSWORD = randomBytes(12).toString('hex');

type Row = Record<string, any>;
const product: Row = { id: 'p1', ozonOfferId: 'SK-04005', name: 'Кофемашина', ozonReferencePrice: 45797 };
let sentToOzon: Row[] = [];
let ozonErrors: string[] = [];

class StubPrismaClient {
  constructor() {
    const stub: Row = {
      product: {
        findUnique: async (a: Row) => (a.where.id === product.id ? { ...product } : null),
        update: async (a: Row) => { Object.assign(product, a.data); return { ...product }; },
      },
    };
    return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; return stub[key as string] ?? new Proxy({}, { get: () => async () => [] }); } });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
const ozonPath = require.resolve(path.join(__dirname, '../src/integrations/ozon.client'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realOzon = require(ozonPath);
realOzon.ozonClient.fetchPriceDetails = async () => ({ offerId: 'SK-04005', price: 49900, oldPrice: 59900, minPrice: 40000, sellingPrice: 45797, currency: 'KZT' });
realOzon.ozonClient.updatePrice = async (i: Row) => { sentToOzon.push(i); return ozonErrors; };
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
beforeEach(() => { sentToOzon = []; ozonErrors = []; product.ozonReferencePrice = 45797; });

describe('Цена на Ozon из админки', () => {
  test('текущие цены с Ozon', async () => {
    const r = await call('GET', '/api/sync/ozon-price/p1');
    assert.equal(r.status, 200);
    assert.equal(r.json.oldPrice, 59900);
    assert.equal(r.json.minPrice, 40000);
  });

  test('цена, старая и минимальная уходят на Ozon; юнит-экономика — от цены продажи', async () => {
    const r = await call('POST', '/api/sync/ozon-price/p1', { price: 47900, oldPrice: 55900, minPrice: 42000 });
    assert.equal(r.status, 200);
    assert.deepEqual(sentToOzon[0], { offerId: 'SK-04005', price: 47900, oldPrice: 55900, minPrice: 42000, currency: 'KZT' });
    assert.equal(product.ozonReferencePrice, 47900);
  });

  test('пустая старая цена = убрать зачёркнутую; пустая минимальная = не менять', async () => {
    await call('POST', '/api/sync/ozon-price/p1', { price: 47900, oldPrice: '', minPrice: '' });
    assert.equal(sentToOzon[0].oldPrice, 0);
    assert.equal(sentToOzon[0].minPrice, undefined);
  });

  test('проверки до отправки', async () => {
    assert.equal((await call('POST', '/api/sync/ozon-price/p1', { price: 0 })).status, 400);
    assert.equal((await call('POST', '/api/sync/ozon-price/p1', { price: 50000, oldPrice: 49000 })).status, 400);
    assert.equal((await call('POST', '/api/sync/ozon-price/p1', { price: 50000, minPrice: 51000 })).status, 400);
    assert.equal(sentToOzon.length, 0);
  });

  test('Ozon отказал — цена у нас не меняется, причина видна', async () => {
    ozonErrors = ['У ключа Ozon нет прав менять цены'];
    const r = await call('POST', '/api/sync/ozon-price/p1', { price: 47900 });
    assert.equal(r.status, 422);
    assert.match(r.json.details, /нет прав/);
    assert.equal(product.ozonReferencePrice, 45797);
  });
});
