/** Загрузка в Cloudflare R2: прямая ссылка (видео до 50 МБ мимо Vercel) и старый /upload. S3 — заглушка. */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = randomBytes(8).toString('hex');
process.env.ADMIN_USER = 'admin-test';
process.env.ADMIN_PASSWORD = randomBytes(12).toString('hex');
process.env.BLOB_READ_WRITE_TOKEN = 'stub-token';
process.env.R2_ACCOUNT_ID = 'acc123';
process.env.R2_ACCESS_KEY_ID = 'key';
process.env.R2_SECRET_ACCESS_KEY = 'secret';
// R2_BUCKET_NAME не задан — по умолчанию mymarket-videos. R2_PUBLIC_URL без https:// — как в Vercel.
process.env.R2_PUBLIC_URL = 'pub-test.r2.dev';

type Row = Record<string, any>;
const sent: Row[] = [];
const blobPuts: string[] = [];
let r2Fail: string | null = null;

class StubPrismaClient {
  constructor() {
    return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; return new Proxy({}, { get: () => async () => [] }); } });
  }
}
function stub(name: string, exports: Row) {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports } as any;
}
stub('@prisma/client', { PrismaClient: StubPrismaClient, Prisma: {} });
class PutObjectCommand { constructor(readonly input: Row) {} }
class S3Client {
  constructor(readonly config: Row) {}
  async send(cmd: PutObjectCommand) {
    if (r2Fail) { const e: any = new Error(r2Fail); e.name = r2Fail; throw e; }
    sent.push({ ...cmd.input, endpoint: this.config.endpoint });
    return {};
  }
}
stub('@aws-sdk/client-s3', { S3Client, PutObjectCommand });
stub('@aws-sdk/s3-request-presigner', {
  getSignedUrl: async (_c: S3Client, cmd: PutObjectCommand, o: Row) => `https://acc123.r2.cloudflarestorage.com/${cmd.input.Bucket}/${cmd.input.Key}?X-Amz-Expires=${o.expiresIn}&ct=${cmd.input.ContentType}`,
});
stub('@vercel/blob', { put: async (pathname: string) => { blobPuts.push(pathname); return { url: `https://blob.example.com/${pathname}` }; } });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;

let port = 0;
let server: http.Server;
function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)),
      authorization: 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString('base64'),
    };
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json: any = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const MB = 1024 * 1024;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { sent.length = 0; blobPuts.length = 0; r2Fail = null; });

describe('Cloudflare R2 — загрузка видео', () => {
  test('upload-info: видео — в R2 до 100 МБ, фото — как раньше в Blob', async () => {
    const r = await call('GET', '/api/shop/admin/upload-info');
    assert.equal(r.json.videoStorage, 'r2');
    assert.equal(r.json.imageStorage, 'blob');
    assert.equal(r.json.maxVideoBytes, 100 * MB);
  });

  test('видео 90 МБ: ссылка для загрузки в бакет mymarket-videos и публичная ссылка https://pub…/имя.mp4', async () => {
    const r = await call('POST', '/api/shop/admin/upload-url', { purpose: 'video', filename: 'Мой ролик.mp4', contentType: 'video/mp4', size: 90 * MB });
    assert.equal(r.status, 200);
    assert.equal(r.json.method, 'PUT');
    assert.equal(r.json.headers['Content-Type'], 'video/mp4');
    assert.match(r.json.uploadUrl, /^https:\/\/acc123\.r2\.cloudflarestorage\.com\/mymarket-videos\/\d+-/);
    assert.match(r.json.url, /^https:\/\/pub-test\.r2\.dev\/\d+-[a-z0-9]+-[\w.-]+\.mp4$/);
  });

  test('больше 100 МБ, не видео и неверный формат — отказ', async () => {
    const big = await call('POST', '/api/shop/admin/upload-url', { purpose: 'video', filename: 'a.mp4', contentType: 'video/mp4', size: 101 * MB });
    assert.equal(big.status, 413);
    assert.match(big.json.error, /максимум 100\.0 МБ/);
    const img = await call('POST', '/api/shop/admin/upload-url', { purpose: 'image', filename: 'a.jpg', contentType: 'image/jpeg', size: MB });
    assert.equal(img.status, 400);
    assert.equal(img.json.reason, 'not_video');
    const bad = await call('POST', '/api/shop/admin/upload-url', { purpose: 'video', filename: 'a.mov', contentType: 'video/quicktime', size: MB });
    assert.equal(bad.status, 400);
  });

  test('маленькое видео через старый /upload — тоже в R2; фото — по-прежнему в Blob', async () => {
    const v = await call('POST', '/api/shop/admin/upload', { kind: 'image', purpose: 'video', filename: 'a.mp4', contentType: 'video/mp4', dataBase64: Buffer.alloc(1000, 1).toString('base64') });
    assert.equal(v.status, 200);
    assert.match(v.json.url, /^https:\/\/pub-test\.r2\.dev\/\d+-/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].Bucket, 'mymarket-videos');
    assert.equal(sent[0].ContentType, 'video/mp4');
    assert.equal(sent[0].endpoint, 'https://acc123.r2.cloudflarestorage.com');

    const p = await call('POST', '/api/shop/admin/upload', { kind: 'image', filename: 'a.jpg', contentType: 'image/jpeg', dataBase64: Buffer.alloc(1000, 1).toString('base64') });
    assert.equal(p.status, 200);
    assert.match(p.json.url, /^https:\/\/blob\.example\.com\/shop\/image\/\d+-a\.jpg$/);
    assert.equal(sent.length, 1);
    assert.equal(blobPuts.length, 1);
  });

  test('R2 недоступен — понятный текст ошибки', async () => {
    r2Fail = 'InvalidAccessKeyId';
    const r = await call('POST', '/api/shop/admin/upload', { kind: 'image', purpose: 'video', filename: 'a.mp4', contentType: 'video/mp4', dataBase64: Buffer.alloc(10, 1).toString('base64') });
    assert.equal(r.status, 500);
    assert.match(r.json.details, /неверные R2_ACCESS_KEY_ID/);
  });
});
