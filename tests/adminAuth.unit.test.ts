import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  evaluateAdminAccess,
  normalizeRequestPath,
  isPublicApiPath,
  isCrossSiteRequest,
  credentialsAreUsable,
  ADMIN_MIN_PASSWORD_LENGTH,
  type AdminCredentials,
  type GuardRequest,
} from '../src/middleware/adminAuth';

// Тестовые учётные данные генерируются на лету и нигде не печатаются.
const CREDS: AdminCredentials = { user: 'admin-test', password: randomBytes(12).toString('hex') };

function basic(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}
function req(url: string, init: { method?: string; headers?: Record<string, string> } = {}): GuardRequest {
  return { method: init.method ?? 'GET', url, headers: { ...(init.headers ?? {}) } };
}
const authed = (url: string, extra: Record<string, string> = {}, method = 'GET'): GuardRequest =>
  req(url, { method, headers: { authorization: basic(CREDS.user, CREDS.password), ...extra } });

// Пути, которые ДОЛЖНЫ требовать входа — включая попытки обхода формой адреса.
const PROTECTED_URLS = [
  '/api/products',
  '/API/PRODUCTS',
  '/api/Products/',
  '/api//products',
  '/api/./products',
  '/api/health/../products',
  '/api/%70roducts',
  '/api\\products',
  '/api/products?x=/api/health',
  '/api/products#/api/health',
  'http://example.com/api/products',
  '//api/products',
  '/api/shop/admin',
  '/api/shop/admin/upload',
  '/API/SHOP/ADMIN/UPLOAD',
  '/api/shop//admin/upload',
  '/api/shop/%61dmin/upload',
  '/api/shop/admin/orders/1/waybill',
  '/api/shop-admin/orders',
  '/api/yard-admin/shops',
  '/api/wholesalers',
  '/api/settings/kaspi-store',
  '/api/settings/kaspi-store?token=x',
  '/api/settings/ozon-store/',
  '/API/Settings/WB-Store',
  '/api/settings/tax',
  '/api/sync/kaspi',
  '/api/repricer/run',
  '/api/orders',
  '/api/analytics/summary',
  '/api/expenses/manual',
  '/api/reviews',
  '/api/margin-calculator/scrape',
  '/api/niches/analyze',
  '/api/kaspi/other',
  '/api/cron/sync',
  '/api/health/x',
  '/api/healthz',
  '/api',
  '/api/',
  '/api/shop',
  '/api/%zz', // некорректное %-кодирование → считаем защищённым
];

// Пути, которые остаются публичными.
const PUBLIC_URLS = [
  '/api/health',
  '/API/HEALTH',
  '/api/health/',
  '/api/health?x=1',
  '/api/shop/products',
  '/api/shop/catalog-types',
  '/api/shop/yard/nearby?lat=1&lng=2',
  '/api/SHOP/Orders',
  '/api/shop/admin2/x', // не поддерево /api/shop/admin; внутри shopRouter всё равно требуется x-app-key
  '/api/kaspi/price-feed.xml',
  '/api/kaspi/price-feed.xml?token=abc',
  '/',
  '/index.html',
  '/dashboard.js',
];

describe('normalizeRequestPath', () => {
  const cases: Array<[string, string | null]> = [
    ['/API/Products/?a=b#c', '/api/products'],
    ['/api//products', '/api/products'],
    ['/api/./x/../products', '/api/products'],
    ['/api/%70roducts', '/api/products'],
    ['/api\\products', '/api/products'],
    ['http://h.example/api/x?y=1', '/api/x'],
    ['/api/%zz', null],
    ['', null],
    ['not a url', null],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizeRequestPath(input), expected);
    });
  }
});

describe('публичные и защищённые пути (без входа)', () => {
  for (const url of PROTECTED_URLS) {
    test(`защищён: ${url}`, () => {
      const d = evaluateAdminAccess(req(url), CREDS);
      assert.equal(d.allow, false);
      if (!d.allow) {
        assert.equal(d.status, 401);
        assert.equal(d.code, 'ADMIN_AUTH_REQUIRED');
        assert.match(d.headers['WWW-Authenticate'] ?? '', /^Basic realm=/);
      }
    });
  }
  for (const url of PUBLIC_URLS) {
    test(`публичен: ${url}`, () => {
      assert.equal(evaluateAdminAccess(req(url), CREDS).allow, true);
    });
  }
  test('isPublicApiPath: поддерево /api/shop/admin не публичное', () => {
    assert.equal(isPublicApiPath('/api/shop/admin'), false);
    assert.equal(isPublicApiPath('/api/shop/admin/upload'), false);
    assert.equal(isPublicApiPath('/api/shop/products'), true);
  });
});

describe('учётные данные не заданы или слабые → закрыто (503), открытого режима нет', () => {
  const broken: Array<[string, AdminCredentials]> = [
    ['нет пользователя', { user: '', password: CREDS.password }],
    ['нет пароля', { user: CREDS.user, password: '' }],
    ['нет ничего', { user: '', password: '' }],
    [`пароль короче ${ADMIN_MIN_PASSWORD_LENGTH}`, { user: CREDS.user, password: 'a'.repeat(ADMIN_MIN_PASSWORD_LENGTH - 1) }],
  ];
  for (const [name, creds] of broken) {
    test(name, () => {
      assert.equal(credentialsAreUsable(creds), false);
      for (const url of ['/api/products', '/api/settings/kaspi-store', '/api/shop-admin/orders', '/api/shop/admin/upload']) {
        const d = evaluateAdminAccess(
          req(url, { headers: { authorization: basic(creds.user, creds.password) } }),
          creds,
        );
        assert.equal(d.allow, false, url);
        if (!d.allow) {
          assert.equal(d.status, 503, url);
          assert.equal(d.code, 'ADMIN_AUTH_NOT_CONFIGURED', url);
        }
      }
      // публичное при этом работает
      assert.equal(evaluateAdminAccess(req('/api/health'), creds).allow, true);
      assert.equal(evaluateAdminAccess(req('/api/shop/products'), creds).allow, true);
    });
  }
});

describe('проверка Basic', () => {
  const url = '/api/shop-admin/orders';
  test('без заголовка → 401', () => {
    const d = evaluateAdminAccess(req(url), CREDS);
    assert.equal(d.allow === false && d.status, 401);
  });
  test('верные данные → доступ', () => {
    assert.equal(evaluateAdminAccess(authed(url), CREDS).allow, true);
  });
  test('схема в нижнем регистре тоже принимается', () => {
    const h = 'basic ' + Buffer.from(`${CREDS.user}:${CREDS.password}`).toString('base64');
    assert.equal(evaluateAdminAccess(req(url, { headers: { authorization: h } }), CREDS).allow, true);
  });
  const bad: Array<[string, string]> = [
    ['неверный пароль', basic(CREDS.user, CREDS.password + 'x')],
    ['пароль без последнего символа', basic(CREDS.user, CREDS.password.slice(0, -1))],
    ['неверный пользователь', basic('other', CREDS.password)],
    ['пустой пароль', basic(CREDS.user, '')],
    ['пустой пользователь', basic('', CREDS.password)],
    ['Bearer вместо Basic', 'Bearer ' + CREDS.password],
    ['мусор вместо base64', 'Basic !!!notbase64!!!'],
    ['нет двоеточия', 'Basic ' + Buffer.from(CREDS.user + CREDS.password).toString('base64')],
    ['только схема', 'Basic'],
    ['пустое значение', ''],
  ];
  for (const [name, header] of bad) {
    test(`отказ: ${name}`, () => {
      const d = evaluateAdminAccess(req(url, { headers: { authorization: header } }), CREDS);
      assert.equal(d.allow, false);
      if (!d.allow) assert.equal(d.status, 401);
    });
  }
  test('пароль с двоеточиями', () => {
    const c: AdminCredentials = { user: 'boss', password: 'abc:def:0123456789' };
    assert.equal(evaluateAdminAccess(authed(url), c).allow, false);
    const ok = req(url, { headers: { authorization: basic(c.user, c.password) } });
    assert.equal(evaluateAdminAccess(ok, c).allow, true);
  });
  test('пароль с не-ASCII символами', () => {
    const c: AdminCredentials = { user: 'админ', password: 'пароль-пароль-123' };
    const ok = req(url, { headers: { authorization: basic(c.user, c.password) } });
    assert.equal(evaluateAdminAccess(ok, c).allow, true);
  });
  test('ответ об отказе не содержит ни пароля, ни заголовка Authorization', () => {
    const d = evaluateAdminAccess(authed(url, {}, 'GET'), { user: CREDS.user, password: 'другой-пароль-0000' });
    assert.equal(d.allow, false);
    const dump = JSON.stringify(d);
    assert.equal(dump.includes(CREDS.password), false);
  });
});

describe('CSRF для изменяющих запросов', () => {
  const url = '/api/products/bulk-delete';
  const post = (extra: Record<string, string>, method = 'POST') => authed(url, extra, method);

  test('без входа сначала 401 (а не 403)', () => {
    const d = evaluateAdminAccess(req(url, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }), CREDS);
    assert.equal(d.allow === false && d.status, 401);
  });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    test(`${method} с другого сайта (Sec-Fetch-Site: cross-site) → 403`, () => {
      const d = evaluateAdminAccess(post({ 'sec-fetch-site': 'cross-site' }, method), CREDS);
      assert.equal(d.allow, false);
      if (!d.allow) assert.equal(d.code, 'CSRF_BLOCKED');
    });
  }
  test('same-site (другой поддомен) → 403', () => {
    assert.equal(evaluateAdminAccess(post({ 'sec-fetch-site': 'same-site' }), CREDS).allow, false);
  });
  test('same-origin (дашборд) → доступ', () => {
    assert.equal(evaluateAdminAccess(post({ 'sec-fetch-site': 'same-origin' }), CREDS).allow, true);
  });
  test('none (действие пользователя) → доступ', () => {
    assert.equal(evaluateAdminAccess(post({ 'sec-fetch-site': 'none' }), CREDS).allow, true);
  });
  test('нет Sec-Fetch-Site и Origin (скрипт/curl) → доступ', () => {
    assert.equal(evaluateAdminAccess(post({}), CREDS).allow, true);
  });
  test('Origin совпадает с Host (старый браузер) → доступ', () => {
    const h = { origin: 'https://app.example', host: 'app.example' };
    assert.equal(evaluateAdminAccess(post(h), CREDS).allow, true);
  });
  test('Origin совпадает с X-Forwarded-Host → доступ', () => {
    const h = { origin: 'https://app.example', host: 'internal', 'x-forwarded-host': 'app.example' };
    assert.equal(evaluateAdminAccess(post(h), CREDS).allow, true);
  });
  test('Origin другой → 403', () => {
    const h = { origin: 'https://evil.example', host: 'app.example' };
    assert.equal(evaluateAdminAccess(post(h), CREDS).allow, false);
  });
  test('Origin: null → 403', () => {
    assert.equal(evaluateAdminAccess(post({ origin: 'null', host: 'app.example' }), CREDS).allow, false);
  });
  test('GET с другого сайта (чтение, CSRF не применяется) → доступ', () => {
    assert.equal(evaluateAdminAccess(authed(url, { 'sec-fetch-site': 'cross-site' }, 'GET'), CREDS).allow, true);
  });
  test('isCrossSiteRequest: пустые заголовки → false', () => {
    assert.equal(isCrossSiteRequest({}), false);
  });
});
