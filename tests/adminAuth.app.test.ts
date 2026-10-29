/**
 * Интеграционные тесты защиты на настоящем Express-приложении (src/expressApp.ts)
 * и на точках входа Vercel (api/index.ts, api/settings/kaspi-store.ts).
 *
 * База данных НЕ используется: @prisma/client подменяется заглушкой ДО загрузки
 * приложения, строка подключения — заведомо нерабочая. Внешние сервисы не
 * вызываются: без входа запрос отклоняется до обработчика, а с входом
 * вызываются только заранее выбранные безопасные маршруты.
 *
 * Тесты точек входа Vercel требуют собранный dist/ (npm run build). Если dist/
 * нет, они помечаются как ПРОПУЩЕННЫЕ (skip), а не как пройденные.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(__dirname, '..');
const ADMIN_USER = 'admin-test';
const ADMIN_PASSWORD = randomBytes(12).toString('hex'); // генерируется на лету, не печатается
const APP_KEY = randomBytes(8).toString('hex');

// --- окружение и заглушка Prisma — до загрузки приложения -----------------
process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SHOP_APP_KEY = APP_KEY;
delete process.env.PRICE_FEED_SECRET;
delete process.env.CRON_SECRET;
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

let prismaCalls = 0;
class StubPrismaClient {
  constructor() {
    return new Proxy(this, {
      get: (_t, key) => {
        if (key === 'then') return undefined;
        return new Proxy(
          {},
          {
            // Ведёт себя как пустая база: единичные выборки → null, count → 0, списки → [].
            get: (_m, method) => async () => {
              prismaCalls++;
              const name = String(method);
              if (/^find(First|Unique)/.test(name)) return null;
              if (name === 'count') return 0;
              return [];
            },
          },
        );
      },
    });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: { PrismaClient: StubPrismaClient, Prisma: {} },
} as any;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/expressApp').default;

// --- утилиты ---------------------------------------------------------------
interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

function request(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* не JSON */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const GOOD = { authorization: basic(ADMIN_USER, ADMIN_PASSWORD) };

/** true — ответ выдан именно защитой админки (а не x-app-key или обработчиком). */
function deniedByGuard(r: Res): boolean {
  const code = r.json?.code;
  return code === 'ADMIN_AUTH_REQUIRED' || code === 'ADMIN_AUTH_NOT_CONFIGURED' || code === 'CSRF_BLOCKED';
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
}

// --- перечисление маршрутов Express ---------------------------------------
interface RouteInfo {
  method: string;
  path: string; // с подставленными параметрами
}

function mountPath(layer: any): string {
  if (layer.regexp?.fast_slash) return '';
  const m = /^\^((?:\\\/[^\\/()?*+]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!m) throw new Error(`Не удалось разобрать путь подключения роутера: ${layer.regexp?.source}`);
  return m[1].replace(/\\\//g, '/');
}

function collectRoutes(stack: any[], prefix: string, out: RouteInfo[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const p = layer.route.path;
      if (p === '*') continue; // запасной маршрут отдачи index.html (не API)
      if (typeof p !== 'string' || /[*()?+]/.test(p)) {
        throw new Error(`Неподдерживаемый вид пути маршрута: ${String(p)} — обновите тест`);
      }
      for (const method of Object.keys(layer.route.methods)) {
        const full = (prefix + p).replace(/:[A-Za-z0-9_]+/g, 'x').replace(/(.)\/+$/, '$1');
        out.push({ method: method.toUpperCase(), path: full });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collectRoutes(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}

// Независимое от реализации описание ожидаемых публичных путей.
const EXPECTED_PUBLIC_EXACT = ['/api/health', '/api/kaspi/price-feed.xml', '/api/telegram-agent/webhook', '/api/telegram-agent/scene'];
function expectedPublic(p: string): boolean {
  if (EXPECTED_PUBLIC_EXACT.includes(p)) return true;
  return p.startsWith('/api/shop/') && p !== '/api/shop/admin' && !p.startsWith('/api/shop/admin/');
}

// --- тесты на Express-приложении -------------------------------------------
describe('Express-приложение целиком (src/expressApp.ts)', () => {
  let server: http.Server;
  let port: number;
  const routes: RouteInfo[] = [];

  before(async () => {
    collectRoutes(app._router.stack, '', routes);
    server = http.createServer(app);
    port = await listen(server);
  });
  after(() => {
    server.close();
    process.env.ADMIN_USER = ADMIN_USER;
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  });

  test('перечисление маршрутов сработало и нашло известные группы', () => {
    const apiRoutes = routes.filter((r) => r.path.startsWith('/api/'));
    assert.ok(apiRoutes.length >= 150, `найдено маршрутов: ${apiRoutes.length}`);
    const has = (m: string, p: string) => routes.some((r) => r.method === m && r.path === p);
    assert.ok(has('GET', '/api/health'));
    assert.ok(has('GET', '/api/settings/kaspi-store'));
    assert.ok(has('POST', '/api/settings/ozon-store'));
    assert.ok(has('POST', '/api/settings/wb-store'));
    assert.ok(has('POST', '/api/repricer/run'));
    assert.ok(has('GET', '/api/shop-admin/orders'));
    assert.ok(has('GET', '/api/yard-admin/shops'));
    assert.ok(has('GET', '/api/wholesalers'));
    assert.ok(has('POST', '/api/shop/admin/upload'));
    assert.ok(has('GET', '/api/shop/yard/nearby'));
    assert.ok(has('GET', '/api/kaspi/price-feed.xml'));
    console.log(`# маршрутов API найдено: ${apiRoutes.length}, публичных ожидается: ${apiRoutes.filter((r) => expectedPublic(r.path)).length}`);
  });

  test('без входа: КАЖДЫЙ защищённый маршрут → 401 с WWW-Authenticate, обработчик не вызывается', async () => {
    const before = prismaCalls;
    for (const r of routes.filter((x) => x.path.startsWith('/api/') && !expectedPublic(x.path))) {
      const res = await request(port, { method: r.method, path: r.path });
      assert.equal(res.status, 401, `${r.method} ${r.path}`);
      assert.equal(res.json?.code, 'ADMIN_AUTH_REQUIRED', `${r.method} ${r.path}`);
      assert.match(String(res.headers['www-authenticate']), /^Basic realm=/, `${r.method} ${r.path}`);
    }
    assert.equal(prismaCalls, before, 'обработчики (обращения к базе) не должны вызываться без входа');
  });

  test('с неверным паролем: каждый защищённый маршрут → 401', async () => {
    const bad = { authorization: basic(ADMIN_USER, ADMIN_PASSWORD + 'x') };
    for (const r of routes.filter((x) => x.path.startsWith('/api/') && !expectedPublic(x.path))) {
      const res = await request(port, { method: r.method, path: r.path, headers: bad });
      assert.equal(res.status, 401, `${r.method} ${r.path}`);
    }
  });

  test('ADMIN_USER / ADMIN_PASSWORD не заданы: каждый защищённый маршрут → 503, никогда не открыт', async () => {
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASSWORD;
    try {
      const before = prismaCalls;
      for (const r of routes.filter((x) => x.path.startsWith('/api/') && !expectedPublic(x.path))) {
        const res = await request(port, { method: r.method, path: r.path, headers: GOOD });
        assert.equal(res.status, 503, `${r.method} ${r.path}`);
        assert.equal(res.json?.code, 'ADMIN_AUTH_NOT_CONFIGURED', `${r.method} ${r.path}`);
      }
      assert.equal(prismaCalls, before);
      // публичное при этом не затронуто
      const health = await request(port, { path: '/api/health' });
      assert.equal(health.status, 200);
    } finally {
      process.env.ADMIN_USER = ADMIN_USER;
      process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    }
  });

  test('слабый пароль (<12) тоже закрывает админку (503)', async () => {
    process.env.ADMIN_PASSWORD = 'short';
    try {
      const res = await request(port, {
        path: '/api/settings/kaspi-store',
        headers: { authorization: basic(ADMIN_USER, 'short') },
      });
      assert.equal(res.status, 503);
    } finally {
      process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    }
  });

  test('публичные маршруты не отклоняются защитой админки (без x-app-key приложение отвечает своим 401)', async () => {
    for (const r of routes.filter((x) => expectedPublic(x.path))) {
      if (r.path === '/api/kaspi/price-feed.xml' || r.path === '/api/telegram-agent/webhook' || r.path === '/api/telegram-agent/scene') continue; // публичные, свои тесты
      const res = await request(port, { method: r.method, path: r.path });
      assert.equal(deniedByGuard(res), false, `${r.method} ${r.path}`);
      if (r.path.startsWith('/api/shop/')) {
        assert.equal(res.status, 401, `${r.method} ${r.path}: без x-app-key приложение должно отвечать 401`);
        assert.equal(res.headers['www-authenticate'], undefined, `${r.method} ${r.path}`);
      }
    }
  });

  test('x-app-key по-прежнему обязателен и работает: каталог с ключом проходит', async () => {
    const withKey = await request(port, { path: '/api/shop/products', headers: { 'x-app-key': APP_KEY } });
    assert.equal(deniedByGuard(withKey), false);
    assert.equal(withKey.status, 200);
    const wrongKey = await request(port, { path: '/api/shop/products', headers: { 'x-app-key': 'wrong' } });
    assert.equal(wrongKey.status, 401);
  });

  test('«Двор»: API приложения проходит защиту админки и требует только x-app-key', async () => {
    const noKey = await request(port, { path: '/api/shop/yard/nearby?lat=43&lng=76' });
    assert.equal(noKey.status, 401);
    assert.equal(deniedByGuard(noKey), false);
    const withKey = await request(port, { path: '/api/shop/yard/nearby?lat=43&lng=76', headers: { 'x-app-key': APP_KEY } });
    assert.equal(deniedByGuard(withKey), false);
    assert.equal(withKey.status, 200);
  });

  test('фид Kaspi: поведение не менялось (защита админки его не трогает)', async () => {
    const res = await request(port, { path: '/api/kaspi/price-feed.xml' });
    assert.equal(deniedByGuard(res), false);
  });

  test('/api/health публичный и отвечает 200', async () => {
    const res = await request(port, { path: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
  });

  test('статика/не-API путь не требует входа', async () => {
    const res = await request(port, { path: '/' });
    assert.equal(deniedByGuard(res), false);
  });

  test('с верным входом выбранные безопасные админские GET проходят защиту', async () => {
    for (const p of [
      '/api/settings/kaspi-store',
      '/api/settings/ozon-store',
      '/api/settings/wb-store',
      '/api/settings/tax',
      '/api/wholesalers',
      '/api/yard-admin/shops',
      '/api/shop-admin/catalog-types',
    ]) {
      const res = await request(port, { path: p, headers: GOOD });
      assert.equal(deniedByGuard(res), false, p);
      assert.notEqual(res.status, 401, p);
      assert.notEqual(res.status, 503, p);
    }
  });

  test('same-origin изменяющий запрос дашборда проходит защиту (запрос с некорректным телом → ответ обработчика, не защиты)', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/api/settings/tax',
      headers: { ...GOOD, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:' + port, host: '127.0.0.1:' + port },
      body: '{}',
    });
    assert.equal(deniedByGuard(res), false);
  });

  test('кросс-сайтовые изменяющие запросы: КАЖДЫЙ защищённый POST/PUT/PATCH/DELETE → 403, обработчик не вызывается', async () => {
    const before = prismaCalls;
    let checked = 0;
    for (const r of routes.filter((x) => x.path.startsWith('/api/') && !expectedPublic(x.path) && x.method !== 'GET' && x.method !== 'HEAD')) {
      const res = await request(port, {
        method: r.method,
        path: r.path,
        headers: { ...GOOD, 'sec-fetch-site': 'cross-site' },
      });
      assert.equal(res.status, 403, `${r.method} ${r.path}`);
      assert.equal(res.json?.code, 'CSRF_BLOCKED');
      checked++;
    }
    assert.ok(checked >= 50, `проверено изменяющих маршрутов: ${checked}`);
    assert.equal(prismaCalls, before);
    console.log(`# изменяющих защищённых маршрутов проверено на CSRF: ${checked}`);
  });

  describe('попытки обхода формой адреса (с реальным сервером)', () => {
    const variants = [
      '/API/SETTINGS/KASPI-STORE',
      '/api//settings/kaspi-store',
      '/api/settings/kaspi-store/',
      '/api/settings/kaspi-store?token=x&a=/api/health',
      '/api/./settings/kaspi-store',
      '/api/health/../settings/kaspi-store',
      '/api/%73ettings/kaspi-store',
      '/api/SHOP/ADMIN/upload',
      '/api/shop//admin/upload',
      '/api/Shop-Admin/orders',
      '//api/shop-admin/orders',
      'http://example.com/api/shop-admin/orders',
    ];
    for (const v of variants) {
      test(`без входа: ${v}`, async () => {
        const before = prismaCalls;
        const res = await request(port, { path: v });
        assert.notEqual(res.status, 200);
        assert.equal(res.json?.code === 'ADMIN_AUTH_REQUIRED' || res.status === 404, true, `статус ${res.status}`);
        assert.equal(prismaCalls, before, 'обработчик не должен вызываться');
      });
    }
  });
});

// --- точки входа Vercel -----------------------------------------------------
const haveDist =
  fs.existsSync(path.join(ROOT, 'dist/middleware/adminAuth.js')) && fs.existsSync(path.join(ROOT, 'dist/expressApp.js'));
const SKIP = haveDist ? false : 'dist/ не собран — выполните npm run build (эти проверки НЕ были выполнены)';

/** Минимальная имитация VercelResponse поверх http.ServerResponse. */
function vercelServer(handler: (req: any, res: any) => Promise<any>): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const r: any = res;
      r.status = (c: number) => {
        res.statusCode = c;
        return r;
      };
      r.json = (b: unknown) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(b));
        return r;
      };
      r.send = (b?: unknown) => {
        res.end(b === undefined || b === null ? '' : String(b));
        return r;
      };
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      (req as any).body = body;
      (req as any).query = Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams);
      Promise.resolve(handler(req, r)).catch(() => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end('{}');
        }
      });
    });
  });
}

describe('Точки входа Vercel (нужен dist/)', { skip: SKIP }, () => {
  let indexServer: http.Server;
  let kaspiServer: http.Server;
  let indexPort: number;
  let kaspiPort: number;

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const indexHandler = require('../api/index').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const kaspiHandler = require('../api/settings/kaspi-store').default;
    indexServer = vercelServer(indexHandler);
    kaspiServer = vercelServer(kaspiHandler);
    indexPort = await listen(indexServer);
    kaspiPort = await listen(kaspiServer);
  });
  after(() => {
    indexServer?.close();
    kaspiServer?.close();
    process.env.ADMIN_USER = ADMIN_USER;
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  });

  const settingsPaths = [
    '/api/settings/kaspi-store',
    '/api/settings/ozon-store',
    '/api/settings/wb-store',
    '/API/Settings/Kaspi-Store',
    '/api//settings/ozon-store',
    '/api/settings/wb-store/',
    '/api/settings/kaspi-store?id=1&token=x',
  ];

  for (const method of ['GET', 'POST', 'DELETE']) {
    for (const p of settingsPaths) {
      test(`api/index.ts без входа: ${method} ${p} → 401`, async () => {
        const before = prismaCalls;
        const res = await request(indexPort, { method, path: p, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        assert.equal(res.status, 401);
        assert.equal(res.json?.code, 'ADMIN_AUTH_REQUIRED');
        assert.equal(prismaCalls, before, 'обработчик настроек не должен вызываться');
      });
      test(`api/settings/kaspi-store.ts без входа: ${method} ${p} → 401`, async () => {
        const before = prismaCalls;
        const res = await request(kaspiPort, { method, path: p, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        assert.equal(res.status, 401);
        assert.equal(res.json?.code, 'ADMIN_AUTH_REQUIRED');
        assert.equal(prismaCalls, before);
      });
    }
  }

  test('api/index.ts: неверный пароль на /api/settings/* → 401', async () => {
    const res = await request(indexPort, { path: '/api/settings/ozon-store', headers: { authorization: basic(ADMIN_USER, 'неверный-пароль-0000') } });
    assert.equal(res.status, 401);
  });

  test('api/settings/kaspi-store.ts: неверный пароль → 401', async () => {
    const res = await request(kaspiPort, { path: '/api/settings/kaspi-store', headers: { authorization: basic(ADMIN_USER, 'неверный-пароль-0000') } });
    assert.equal(res.status, 401);
  });

  test('обе точки входа: ADMIN_* не заданы → 503 даже с «правильным» заголовком', async () => {
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASSWORD;
    try {
      for (const [port, p] of [
        [indexPort, '/api/settings/kaspi-store'],
        [indexPort, '/api/settings/ozon-store'],
        [indexPort, '/api/settings/wb-store'],
        [kaspiPort, '/api/settings/kaspi-store'],
      ] as Array<[number, string]>) {
        const res = await request(port, { path: p, headers: GOOD });
        assert.equal(res.status, 503, p);
        assert.equal(res.json?.code, 'ADMIN_AUTH_NOT_CONFIGURED', p);
      }
    } finally {
      process.env.ADMIN_USER = ADMIN_USER;
      process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    }
  });

  test('обе точки входа: с верным входом защита пропускает', async () => {
    for (const [port, p] of [
      [indexPort, '/api/settings/kaspi-store'],
      [indexPort, '/api/settings/ozon-store'],
      [indexPort, '/api/settings/wb-store'],
      [kaspiPort, '/api/settings/kaspi-store'],
    ] as Array<[number, string]>) {
      const res = await request(port, { path: p, headers: GOOD });
      assert.equal(deniedByGuard(res), false, p);
      assert.notEqual(res.status, 401, p);
      assert.notEqual(res.status, 503, p);
    }
  });

  test('обе точки входа: кросс-сайтовый POST с верным входом → 403', async () => {
    for (const [port, p] of [
      [indexPort, '/api/settings/ozon-store'],
      [kaspiPort, '/api/settings/kaspi-store'],
    ] as Array<[number, string]>) {
      const res = await request(port, {
        method: 'POST',
        path: p,
        headers: { ...GOOD, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: '{}',
      });
      assert.equal(res.status, 403, p);
      assert.equal(res.json?.code, 'CSRF_BLOCKED');
    }
  });

  test('api/index.ts: остальные админские маршруты, идущие через Express, тоже закрыты', async () => {
    for (const p of ['/api/products', '/api/shop-admin/orders', '/api/yard-admin/shops', '/api/shop/admin/upload']) {
      const res = await request(indexPort, { path: p });
      assert.equal(res.status, 401, p);
      assert.equal(res.json?.code, 'ADMIN_AUTH_REQUIRED', p);
    }
  });

  test('api/index.ts: публичные пути проходят (health, каталог с x-app-key)', async () => {
    const health = await request(indexPort, { path: '/api/health' });
    assert.equal(health.status, 200);
    const noKey = await request(indexPort, { path: '/api/shop/products' });
    assert.equal(noKey.status, 401);
    assert.equal(deniedByGuard(noKey), false);
    const withKey = await request(indexPort, { path: '/api/shop/products', headers: { 'x-app-key': APP_KEY } });
    assert.equal(withKey.status, 200);
  });
});
