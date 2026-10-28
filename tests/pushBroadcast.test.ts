/**
 * Админская рассылка пушей (/api/push-admin): картинка попадает в payload Expo
 * только когда задана; без неё — обычный пуш. БД и Expo — заглушки.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, generateKeyPairSync, createVerify } from 'node:crypto';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = randomBytes(8).toString('hex');
process.env.ADMIN_USER = 'admin-test';
process.env.ADMIN_PASSWORD = randomBytes(12).toString('hex');

type Row = Record<string, any>;
let tokens: Row[] = [];
const stub: Row = {
  shopCustomerPushToken: {
    findMany: async () => tokens.map((r) => ({ ...r })),
    findUnique: async (a: Row) => {
      const r = tokens.find((x) => x.phone === a.where.phone);
      return r ? { ...r } : null;
    },
  },
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

// --- заглушка Expo: подменяем fetch только для адреса exp.host ---
let expoCalls: Row[][] = [];
let oauthCalls: string[] = [];
let oauthMode: 'ok' | 'bad' = 'ok';
let fcmCalls: Row[] = [];
let expoMode: 'ok' | 'error' | 'notRegistered' | 'http500' = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).startsWith('https://exp.host/')) {
    const msgs: Row[] = JSON.parse(init.body);
    expoCalls.push(msgs);
    if (expoMode === 'http500') return new Response('{}', { status: 500 });
    const data = msgs.map(() =>
      expoMode === 'ok' ? { status: 'ok', id: 'x' }
        : expoMode === 'notRegistered' ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
          : { status: 'error', message: 'bad' });
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    oauthCalls.push(String(init.body));
    if (oauthMode === 'bad') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    return new Response(JSON.stringify({ access_token: 'at-123', expires_in: 3600 }), { status: 200 });
  }
  if (String(url).startsWith('https://fcm.googleapis.com/v1/projects/')) {
    const call = { url: String(url), auth: init.headers.Authorization, message: JSON.parse(init.body).message };
    fcmCalls.push(call);
    const t = call.message.token;
    if (t.includes('gone')) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
    if (t.includes('bad')) return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 });
    return new Response(JSON.stringify({ name: 'projects/p/messages/1' }), { status: 200 });
  }
  if (init?.method === 'HEAD' && String(url).startsWith('https://img-check.example/')) {
    const u = String(url);
    if (u.includes('missing')) return new Response(null, { status: 404 });
    if (u.includes('page')) return new Response(null, { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.includes('big')) return new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '2500000' } });
    return new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '200000' } });
  }
  return realFetch(url, init);
}) as typeof fetch;

let port = 0;
let server: http.Server;
const AUTH = { authorization: 'Basic ' + Buffer.from(`admin-test:${process.env.ADMIN_PASSWORD}`).toString('base64'), 'sec-fetch-site': 'same-origin' };
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h: Record<string, string> = { ...headers };
    if (payload !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = String(Buffer.byteLength(payload)); }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* не JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}
const tok = (i: number) => `ExponentPushToken[abc${i}]`;
before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => { globalThis.fetch = realFetch; return new Promise<void>((r) => server.close(() => r())); });
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { project_id: 'my-proj', client_email: 'svc@my-proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fcmSvc = require('../src/services/fcm.service');
beforeEach(() => { tokens = []; expoCalls = []; expoMode = 'ok'; oauthCalls = []; oauthMode = 'ok'; fcmCalls = []; fcmSvc._resetFcmCache(); process.env.FIREBASE_KEY = JSON.stringify(SA); });

describe('POST /api/push-admin/send', () => {
  test('с картинкой: в сообщении Expo есть richContent.image и data.image, заголовок и текст на месте', async () => {
    tokens = [{ phone: '77001112233', token: tok(1) }];
    const r = await call('POST', '/api/push-admin/send', { title: 'Акция', body: 'Скидки', imageUrl: 'https://blob.example/a.jpg', audience: 'test', testPhone: '+7 700 111 22 33' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sent, 1);
    assert.equal(r.json.withImage, true);
    const m = expoCalls[0][0];
    assert.equal(m.to, tok(1));
    assert.equal(m.title, 'Акция');
    assert.equal(m.body, 'Скидки');
    assert.deepEqual(m.richContent, { image: 'https://blob.example/a.jpg' });
    assert.equal(m.data.image, 'https://blob.example/a.jpg');
  });

  test('без картинки (нет поля / null / пустая строка): пуш обычный, без richContent и image', async () => {
    tokens = [{ phone: '77001112233', token: tok(1) }];
    for (const extra of [{}, { imageUrl: null }, { imageUrl: '' }]) {
      expoCalls = [];
      const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'test', testPhone: '77001112233', ...extra });
      assert.equal(r.status, 200, JSON.stringify(extra));
      assert.equal(r.json.withImage, false);
      const m = expoCalls[0][0];
      assert.ok(!('richContent' in m));
      assert.ok(!('image' in m.data));
      assert.equal(m.title, 'T');
    }
  });

  test('«всем»: 250 Expo-токенов → 3 запроса к Expo (по ≤100), дубли убраны', async () => {
    tokens = Array.from({ length: 250 }, (_, i) => ({ phone: `7700${i}`, token: tok(i) }));
    tokens.push({ phone: 'x2', token: tok(0) });
    const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', imageUrl: 'https://b/x.png', audience: 'all' });
    assert.equal(r.status, 200);
    assert.equal(r.json.sent, 250);
    assert.equal(r.json.expoTokens, 250);
    assert.equal(r.json.fcmTokens, 0);
    assert.equal(fcmCalls.length, 0, 'Expo-токены в Firebase не уходят');
    assert.deepEqual(expoCalls.map((c) => c.length).sort((a, b) => b - a), [100, 100, 50]);
    assert.ok(expoCalls.flat().every((m) => m.richContent.image === 'https://b/x.png'));
  });

  test('ошибки Expo считаются: DeviceNotRegistered отдельно, HTTP 500 — все failed', async () => {
    tokens = [{ phone: '1', token: tok(1) }, { phone: '2', token: tok(2) }];
    expoMode = 'notRegistered';
    let r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.deepEqual([r.json.sent, r.json.failed, r.json.notRegistered], [0, 2, 2]);
    expoMode = 'http500';
    r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.deepEqual([r.json.sent, r.json.failed], [0, 2]);
  });

  test('валидация: нет заголовка/текста/audience, картинка не https, тест без номера или без токена', async () => {
    tokens = [{ phone: '77001112233', token: tok(1) }];
    const bad: Row[] = [
      { body: 'B', audience: 'all' },
      { title: 'T', audience: 'all' },
      { title: 'T', body: 'B' },
      { title: 'T', body: 'B', audience: 'everyone' },
      { title: 'T', body: 'B', audience: 'all', imageUrl: 'http://insecure/x.jpg' },
      { title: 'T', body: 'B', audience: 'all', imageUrl: 'javascript:1' },
      { title: 'T', body: 'B', audience: 'test' },
    ];
    for (const b of bad) assert.equal((await call('POST', '/api/push-admin/send', b)).status, 400, JSON.stringify(b));
    const none = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'test', testPhone: '77009999999' });
    assert.equal(none.status, 404);
    assert.equal(expoCalls.length, 0, 'при отказе в Expo ничего не уходит');
  });

  test('нет получателей → 404, Expo не вызывается', async () => {
    const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.equal(r.status, 404);
    assert.equal(expoCalls.length, 0);
  });

  test('без админ-входа запрещено (401), в том числе с x-app-key приложения', async () => {
    tokens = [{ phone: '1', token: tok(1) }];
    const body = { title: 'T', body: 'B', audience: 'all' };
    assert.equal((await call('POST', '/api/push-admin/send', body, {})).status, 401);
    assert.equal((await call('POST', '/api/push-admin/send', body, { 'x-app-key': process.env.SHOP_APP_KEY! })).status, 401);
    assert.equal((await call('GET', '/api/push-admin/audience', undefined, {})).status, 401);
    assert.equal(expoCalls.length, 0);
  });
});

describe('GET /api/push-admin/audience', () => {
  test('считает все токены и только Expo-токены', async () => {
    tokens = [{ phone: '1', token: tok(1) }, { phone: '2', token: 'fcm' }];
    const r = await call('GET', '/api/push-admin/audience');
    assert.deepEqual(r.json, { total: 2, expo: 1, fcm: 1, firebaseConfigured: true });
  });
});

describe('Firebase (FCM HTTP v1) напрямую для FCM-токенов', () => {
  const fcmTok = (n: string) => `fcm-device-token-${n}`;

  test('FCM-токен: Firebase получает сообщение с заголовком, текстом и картинкой; Expo не вызывается', async () => {
    tokens = [{ phone: '1', token: fcmTok('a') }];
    const r = await call('POST', '/api/push-admin/send', { title: 'Акция', body: 'Скидки', imageUrl: 'https://blob.example/a.jpg', audience: 'all' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.sent, r.json.failed, r.json.fcmTokens, r.json.expoTokens], [1, 0, 1, 0]);
    assert.equal(expoCalls.length, 0);
    const c = fcmCalls[0];
    assert.equal(c.url, 'https://fcm.googleapis.com/v1/projects/my-proj/messages:send');
    assert.equal(c.auth, 'Bearer at-123');
    assert.equal(c.message.token, fcmTok('a'));
    assert.deepEqual(c.message.notification, { title: 'Акция', body: 'Скидки', image: 'https://blob.example/a.jpg' });
    assert.equal(c.message.android.notification.image, 'https://blob.example/a.jpg');
    assert.equal(c.message.apns.fcm_options.image, 'https://blob.example/a.jpg');
    assert.equal(c.message.data.image, 'https://blob.example/a.jpg');
  });

  test('без картинки: в сообщении Firebase нет image ни в одном месте', async () => {
    tokens = [{ phone: '1', token: fcmTok('a') }];
    await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    const m = fcmCalls[0].message;
    assert.deepEqual(m.notification, { title: 'T', body: 'B' });
    assert.ok(!('image' in m.data) && !('android' in m) && !('apns' in m));
  });

  test('JWT для Google подписан ключом сервисного аккаунта (RS256), scope firebase.messaging', async () => {
    tokens = [{ phone: '1', token: fcmTok('a') }];
    await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    const form = new URLSearchParams(oauthCalls[0]);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, sig] = form.get('assertion')!.split('.');
    const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.equal(claim.iss, SA.client_email);
    assert.equal(claim.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(claim.aud, 'https://oauth2.googleapis.com/token');
    const v = createVerify('RSA-SHA256').update(`${h}.${c}`);
    assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')), 'подпись должна проверяться публичным ключом');
  });

  test('токен доступа кэшируется между рассылками', async () => {
    tokens = [{ phone: '1', token: fcmTok('a') }];
    await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.equal(oauthCalls.length, 1);
    assert.equal(fcmCalls.length, 2);
  });

  test('смесь Expo и FCM токенов: каждый уходит своим каналом, итоги суммируются', async () => {
    tokens = [{ phone: '1', token: tok(1) }, { phone: '2', token: fcmTok('a') }, { phone: '3', token: fcmTok('b') }];
    const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.deepEqual([r.json.sent, r.json.expoTokens, r.json.fcmTokens], [3, 1, 2]);
    assert.equal(expoCalls.flat().length, 1);
    assert.equal(fcmCalls.length, 2);
  });

  test('ошибки Firebase по токенам: UNREGISTERED и прочие считаются отдельно', async () => {
    tokens = [{ phone: '1', token: fcmTok('ok') }, { phone: '2', token: fcmTok('gone') }, { phone: '3', token: fcmTok('bad') }];
    const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.deepEqual([r.json.sent, r.json.failed, r.json.notRegistered], [1, 2, 1]);
  });

  test('FIREBASE_KEY не задан / не JSON / старый server key → понятная ошибка, ничего не отправлено, значение ключа в ответе не светится', async () => {
    tokens = [{ phone: '1', token: fcmTok('a') }];
    for (const bad of ['', 'AAAAold-legacy-server-key:APA91bSECRET', '{"client_email":"x"}']) {
      process.env.FIREBASE_KEY = bad;
      fcmSvc._resetFcmCache();
      const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
      assert.equal(r.status, 200);
      assert.equal(r.json.sent, 0);
      assert.equal(r.json.failed, 1);
      assert.ok(r.json.fcmError, 'есть причина');
      assert.ok(!JSON.stringify(r.json).includes('SECRET'));
    }
    assert.equal(fcmCalls.length, 0);
  });

  test('Google отклонил ключ (invalid_grant) → fcmError, токены не отправлены', async () => {
    tokens = [{ phone: '1', token: fcmTok('a') }];
    oauthMode = 'bad';
    const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.equal(r.json.sent, 0);
    assert.match(r.json.fcmError, /токен доступа/);
    assert.equal(fcmCalls.length, 0);
  });

  test('ключ можно передать в base64 от JSON', async () => {
    process.env.FIREBASE_KEY = Buffer.from(JSON.stringify(SA)).toString('base64');
    tokens = [{ phone: '1', token: fcmTok('a') }];
    const r = await call('POST', '/api/push-admin/send', { title: 'T', body: 'B', audience: 'all' });
    assert.equal(r.json.sent, 1);
  });

  test('audience: показывает число FCM и признак настроенного ключа', async () => {
    tokens = [{ phone: '1', token: fcmTok('a') }];
    process.env.FIREBASE_KEY = '';
    assert.deepEqual((await call('GET', '/api/push-admin/audience')).json, { total: 1, expo: 0, fcm: 1, firebaseConfigured: false });
  });
});

describe('рассылка «всем» берёт ВСЕ токены из базы (Двор: /api/yard-admin/push/broadcast)', () => {
  test('30 устройств с разными телефонами (Expo и FCM) → каждое получает пуш, никто не потерян', async () => {
    tokens = [];
    for (let i = 0; i < 12; i++) tokens.push({ phone: `7701${i}`, token: tok(i) });
    for (let i = 0; i < 18; i++) tokens.push({ phone: `7702${i}`, token: `fcm-device-${i}` });
    const r = await call('POST', '/api/yard-admin/push/broadcast', { title: 'Привет', body: 'Всем' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.total, r.json.sent, r.json.failed], [30, 30, 0]);
    assert.equal(expoCalls.flat().length, 12);
    assert.equal(fcmCalls.length, 18);
    assert.equal(new Set(fcmCalls.map((c) => c.message.token)).size, 18);
    assert.ok(fcmCalls.every((c) => c.message.notification.title === 'Привет' && c.message.notification.body === 'Всем'));
  });

  test('нет токенов → 404; нет title/body → 400', async () => {
    tokens = [];
    assert.equal((await call('POST', '/api/yard-admin/push/broadcast', { title: 'a', body: 'b' })).status, 404);
    assert.equal((await call('POST', '/api/yard-admin/push/broadcast', { title: 'a' })).status, 400);
  });

  test('push-admin «всем»: те же 30 устройств все получают пуш', async () => {
    tokens = [];
    for (let i = 0; i < 30; i++) tokens.push({ phone: `7703${i}`, token: i % 2 ? tok(i) : `fcm-device-${i}` });
    const r = await call('POST', '/api/push-admin/send', { title: 'А', body: 'Б', audience: 'all' });
    assert.deepEqual([r.json.total, r.json.sent, r.json.failed], [30, 30, 0]);
  });
});

describe('пуш с кодом выдачи — только покупателю заказа', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sendPickupCodePush } = require('../src/lib/expoPush');

  test('FCM-токен покупателя: Firebase получает «Код выдачи: 12345», больше никто', async () => {
    tokens = [{ phone: '77011112233', token: 'fcm-buyer' }, { phone: '77019998877', token: 'fcm-other' }, { phone: '77015556677', token: tok(1) }];
    await sendPickupCodePush('77011112233', '12345', 'MM-100');
    assert.equal(expoCalls.length, 0);
    assert.equal(fcmCalls.length, 1);
    const m = fcmCalls[0].message;
    assert.equal(m.token, 'fcm-buyer');
    assert.equal(m.notification.body, 'Код выдачи: 12345');
    assert.equal(m.data.type, 'pickup_code');
    assert.equal(m.data.pickupCode, '12345');
    assert.equal(m.data.orderNumber, 'MM-100');
  });

  test('Expo-токен покупателя: уходит через Expo, текст «Код выдачи: 54321»', async () => {
    tokens = [{ phone: '77011112233', token: tok(7) }, { phone: '77019998877', token: 'fcm-other' }];
    await sendPickupCodePush('77011112233', '54321', 'MM-101');
    assert.equal(fcmCalls.length, 0);
    assert.equal(expoCalls.length, 1);
    assert.equal(expoCalls[0].length, 1);
    assert.equal(expoCalls[0][0].to, tok(7));
    assert.equal(expoCalls[0][0].body, 'Код выдачи: 54321');
    assert.equal((expoCalls[0][0].data as Row).type, 'pickup_code');
  });

  test('нет токена у покупателя → ничего не отправляется и ошибки нет', async () => {
    tokens = [{ phone: '77019998877', token: 'fcm-other' }];
    await sendPickupCodePush('77011112233', '11111', 'MM-102');
    assert.equal(fcmCalls.length + expoCalls.length, 0);
  });

  test('Firebase отказал → функция не бросает исключение', async () => {
    tokens = [{ phone: '77011112233', token: 'fcm-bad' }];
    await assert.doesNotReject(() => sendPickupCodePush('77011112233', '22222', 'MM-103'));
  });
});

describe('картинка пуша: проверка ссылки и предупреждения', () => {
  const send = (imageUrl: string) => call('POST', '/api/push-admin/send', { title: 'А', body: 'Б', imageUrl, audience: 'all' });
  beforeEach(() => { tokens = [{ phone: '1', token: 'fcm-device-x' }, { phone: '2', token: tok(1) }]; });

  test('нормальная картинка: уходит в Firebase (notification.image, android, data) и в Expo (richContent); предупреждения нет', async () => {
    const url = 'https://img-check.example/ok.jpg';
    const r = await send(url);
    assert.equal(r.json.sent, 2);
    assert.equal(r.json.imageWarning, undefined);
    const m = fcmCalls[0].message;
    assert.equal(m.notification.image, url);
    assert.equal(m.android.notification.image, url);
    assert.equal(m.data.image, url);
    assert.deepEqual(expoCalls[0][0].richContent, { image: url });
  });

  test('тяжелее 1 МБ → пуш уходит, но с предупреждением про Android', async () => {
    const r = await send('https://img-check.example/big.jpg');
    assert.equal(r.json.sent, 2);
    assert.match(r.json.imageWarning, /1 МБ/);
  });

  test('ссылка 404 / не картинка → предупреждение, пуш всё равно отправлен', async () => {
    const a = await send('https://img-check.example/missing.jpg');
    assert.match(a.json.imageWarning, /недоступна/);
    const b = await send('https://img-check.example/page.html');
    assert.match(b.json.imageWarning, /не на картинку/);
    assert.equal(b.json.sent, 2);
  });

  test('без картинки проверка не выполняется и предупреждения нет', async () => {
    const r = await call('POST', '/api/push-admin/send', { title: 'А', body: 'Б', audience: 'all' });
    assert.equal(r.json.imageWarning, undefined);
  });
});
