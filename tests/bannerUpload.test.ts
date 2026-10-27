/** Загрузка баннеров главной: POST /api/shop/admin/upload (purpose='banner') — GIF, MP4, WEBM. Blob — заглушка. */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const APP_KEY = randomBytes(8).toString('hex');
process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = APP_KEY;
process.env.ADMIN_USER = 'admin-test';
process.env.ADMIN_PASSWORD = randomBytes(12).toString('hex');

process.env.BLOB_READ_WRITE_TOKEN = 'stub-token';
type Row = Record<string, any>;
const puts: Array<{ pathname: string; size: number; contentType: string }> = [];
let blobFail = false;

class StubPrismaClient {
  constructor() {
    return new Proxy(this, {
      get(_t, key) {
        if (key === 'then') return undefined;
        return new Proxy({}, { get: () => async () => [] });
      },
    });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
const blobPath = require.resolve('@vercel/blob');
require.cache[blobPath] = {
  id: blobPath, filename: blobPath, loaded: true,
  exports: {
    put: async (pathname: string, body: Buffer, o: Row) => {
      if (blobFail) throw new Error('blob down');
      puts.push({ pathname, size: body.length, contentType: o.contentType });
      return { url: `https://blob.example.com/${pathname}` };
    },
  },
} as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MAX_BANNER_BYTES } = require('../src/routes/shopMedia.routes');

let port = 0;
let server: http.Server;
function post(body: unknown, auth = true): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) };
    if (auth) headers.authorization = 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString('base64');
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/shop/admin/upload', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* не JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}
const file = (bytes: number, contentType: string, filename: string, purpose?: 'banner') => ({
  kind: 'image', ...(purpose ? { purpose } : {}), filename, contentType, dataBase64: Buffer.alloc(bytes, 1).toString('base64'),
});

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { puts.length = 0; blobFail = false; });

describe('загрузка баннеров главной: GIF / MP4 / WEBM', () => {
  test('GIF, MP4, WEBM и обычные картинки принимаются, ссылка на файл возвращается как есть', async () => {
    for (const [type, name, ext] of [['image/gif', 'a.gif', 'gif'], ['video/mp4', 'a.mp4', 'mp4'], ['video/webm', 'a.webm', 'webm'], ['image/jpeg', 'a.jpg', 'jpg'], ['image/png', 'a.png', 'png'], ['image/webp', 'a.webp', 'webp']]) {
      const r = await post(file(1000, type, name, 'banner'));
      assert.equal(r.status, 200, type);
      assert.match(r.json.url, new RegExp(`^https://blob\\.example\\.com/shop/banner/\\d+-a\\.${ext}$`), type);
    }
    assert.equal(puts.length, 6);
    assert.deepEqual(puts.map((p) => p.contentType), ['image/gif', 'video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp']);
    assert.ok(puts.every((p) => p.size === 1000)); // файл сохраняется как есть
  });

  test('другие форматы отклоняются с понятным текстом', async () => {
    for (const type of ['video/quicktime', 'application/pdf', 'image/svg+xml', 'text/html']) {
      const r = await post(file(100, type, 'x.bin', 'banner'));
      assert.equal(r.status, 400, type);
      assert.equal(r.json.error, 'Формат не поддерживается. Нужен JPEG, PNG, WEBP, GIF, MP4 или WEBM');
    }
    assert.equal(puts.length, 0);
  });

  test('размер: ровно в пределе проходит, больше — 413 и в хранилище не уходит', async () => {
    assert.equal((await post(file(MAX_BANNER_BYTES, 'video/mp4', 'ok.mp4', 'banner'))).status, 200);
    puts.length = 0;
    const r = await post(file(MAX_BANNER_BYTES + 1, 'video/mp4', 'big.mp4', 'banner'));
    assert.equal(r.status, 413);
    assert.match(r.json.error, /слишком большой/);
    assert.equal(puts.length, 0);
  });

  test('без purpose=banner (фото товаров и др.) правила прежние: GIF/видео нельзя, лимит 2.5 МБ', async () => {
    assert.equal((await post(file(100, 'image/gif', 'a.gif'))).status, 400);
    assert.equal((await post(file(100, 'video/mp4', 'a.mp4'))).status, 400);
    assert.equal((await post(file(2.6 * 1024 * 1024, 'image/png', 'a.png'))).status, 413);
    assert.equal((await post(file(1000, 'image/png', 'a.png'))).status, 200);
    assert.match(puts[0].pathname, /^shop\/image\//);
  });

  test('нужна админская авторизация; сбой хранилища → 500', async () => {
    assert.equal((await post(file(100, 'image/gif', 'a.gif', 'banner'), false)).status, 401);
    blobFail = true;
    const r = await post(file(100, 'image/gif', 'a.gif', 'banner'));
    assert.equal(r.status, 500);
  });
});
