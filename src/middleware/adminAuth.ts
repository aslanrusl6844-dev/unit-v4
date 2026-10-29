import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { NextFunction, Request, Response } from 'express';

/**
 * Защита административных API (Basic-авторизация, ADMIN_USER / ADMIN_PASSWORD).
 *
 * Принцип — «закрыто по умолчанию»: любой путь под /api/ требует входа, кроме
 * явного списка публичных (см. isPublicApiPath). Новый маршрут, который
 * забыли внести в список, остаётся закрытым, а не открытым.
 *
 * Правила:
 *  - ADMIN_USER или ADMIN_PASSWORD не заданы (или пароль короче
 *    ADMIN_MIN_PASSWORD_LENGTH) → защищённые маршруты отвечают 503. Режима
 *    «выключить проверку» нет вообще.
 *  - Сравнение учётных данных — через SHA-256 + timingSafeEqual, обе части
 *    сравниваются всегда (без раннего выхода).
 *  - Путь перед сравнением нормализуется (регистр, %-кодирование, двойные
 *    слеши, точки в пути, абсолютный URL в строке запроса, query), чтобы
 *    защиту нельзя было обойти формой адреса.
 *  - Для изменяющих запросов (не GET/HEAD/OPTIONS) отклоняются кросс-сайтовые
 *    запросы (Sec-Fetch-Site / Origin) — браузер сам подставляет Basic-данные
 *    в запросы с чужой страницы (CSRF). Запросы дашборда с того же домена
 *    проходят.
 *  - Секреты, заголовок Authorization и персональные данные не логируются и
 *    не попадают в ответы.
 *
 * Модуль не зависит от Express: evaluateAdminAccess работает с любым
 * Node-запросом, поэтому его же используют точки входа Vercel (api/index.ts,
 * api/settings/kaspi-store.ts), которые обрабатывают часть маршрутов в обход
 * Express.
 */

export const ADMIN_REALM = 'unit-v4 admin';
export const ADMIN_MIN_PASSWORD_LENGTH = 12;

export interface AdminCredentials {
  user: string;
  password: string;
}

export interface GuardRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
}

export type GuardDecision =
  | { allow: true }
  | {
      allow: false;
      status: 401 | 403 | 503;
      code: 'ADMIN_AUTH_REQUIRED' | 'ADMIN_AUTH_NOT_CONFIGURED' | 'CSRF_BLOCKED';
      error: string;
      headers: Record<string, string>;
    };

/** Читается на КАЖДЫЙ запрос (а не при загрузке модуля): Vercel подставляет env до старта, но тесты и смена значений так работают без перезагрузки. */
export function readAdminCredentialsFromEnv(): AdminCredentials {
  return {
    user: (process.env.ADMIN_USER ?? '').trim(),
    password: (process.env.ADMIN_PASSWORD ?? '').trim(),
  };
}

export function credentialsAreUsable(c: AdminCredentials): boolean {
  return c.user.length > 0 && c.password.length >= ADMIN_MIN_PASSWORD_LENGTH;
}

// ---------------------------------------------------------------------
// Нормализация пути
// ---------------------------------------------------------------------

/**
 * Приводит строку запроса к виду, в котором её можно сравнивать со списком
 * публичных путей. Возвращает null, если разобрать адрес нельзя — такой запрос
 * считается защищённым.
 */
export function normalizeRequestPath(rawUrl: string | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;

  let path: string;
  if (rawUrl.startsWith('/')) {
    const cut = rawUrl.search(/[?#]/);
    path = cut === -1 ? rawUrl : rawUrl.slice(0, cut);
  } else {
    // Абсолютная форма строки запроса ("GET http://host/api/x HTTP/1.1"):
    // Express (parseurl) берёт из неё pathname и маршрутизирует как обычно.
    try {
      path = new URL(rawUrl).pathname;
    } catch {
      return null;
    }
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }

  path = path.replace(/\\/g, '/').toLowerCase();

  // Схлопываем повторные слеши и убираем сегменты "." и ".."
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return '/' + out.join('/');
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Явно публичные пути. Всё остальное под /api/ — административное.
 *  - /api/health                    — проверка работоспособности;
 *  - /api/shop/... кроме /api/shop/admin — API приложения (свой x-app-key
 *    внутри shopRouter / yardRouter);
 *  - /api/kaspi/price-feed.xml      — фид Kaspi, защита ?token внутри роута
 *    (поведение намеренно не менялось).
 * /api/cron/* здесь нет: это отдельные функции Vercel с CRON_SECRET, они
 * эту проверку не вызывают.
 */
export function isPublicApiPath(path: string): boolean {
  if (path === '/api/health') return true;
  if (path === '/api/kaspi/price-feed.xml') return true;
  if (path === '/api/telegram-agent/webhook') return true; // защита — секрет Telegram в заголовке
  if (path.startsWith('/api/shop/')) {
    const isAdminTree = path === '/api/shop/admin' || path.startsWith('/api/shop/admin/');
    return !isAdminTree;
  }
  return false;
}

// ---------------------------------------------------------------------
// Basic
// ---------------------------------------------------------------------

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function parseBasic(header: string | undefined): { user: string; password: string } | null {
  if (typeof header !== 'string') return null;
  const m = /^basic +([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// ---------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** true — запрос пришёл со страницы другого сайта/поддомена (или происхождение неопределимо). */
export function isCrossSiteRequest(headers: IncomingMessage['headers']): boolean {
  const site = firstHeader(headers['sec-fetch-site'])?.toLowerCase();
  if (site) return !(site === 'same-origin' || site === 'none');

  const origin = firstHeader(headers['origin']);
  if (origin === undefined) return false; // не браузерный клиент или старый браузер без Origin
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true; // Origin: null и т.п.
  }
  const hosts = [firstHeader(headers['host']), firstHeader(headers['x-forwarded-host'])]
    .filter((h): h is string => typeof h === 'string' && h.length > 0)
    .map((h) => h.split(',')[0].trim().toLowerCase());
  return !hosts.includes(originHost);
}

// ---------------------------------------------------------------------
// Решение
// ---------------------------------------------------------------------

export function evaluateAdminAccess(
  req: GuardRequest,
  creds: AdminCredentials = readAdminCredentialsFromEnv(),
): GuardDecision {
  const path = normalizeRequestPath(req.url);

  if (path !== null) {
    if (!isApiPath(path)) return { allow: true }; // статика / не API
    if (isPublicApiPath(path)) return { allow: true };
  }
  // path === null или защищённый путь — дальше требуется вход.

  if (!credentialsAreUsable(creds)) {
    return {
      allow: false,
      status: 503,
      code: 'ADMIN_AUTH_NOT_CONFIGURED',
      error: `Админка не настроена: задайте ADMIN_USER и ADMIN_PASSWORD (не короче ${ADMIN_MIN_PASSWORD_LENGTH} символов)`,
      headers: { 'Cache-Control': 'no-store' },
    };
  }

  const given = parseBasic(firstHeader(req.headers['authorization']));
  // Обе проверки выполняются всегда — время не зависит от того, что именно неверно.
  const userOk = safeEqual(given?.user ?? '', creds.user);
  const passOk = safeEqual(given?.password ?? '', creds.password);
  if (!given || !userOk || !passOk) {
    return {
      allow: false,
      status: 401,
      code: 'ADMIN_AUTH_REQUIRED',
      error: 'Требуется вход администратора',
      headers: {
        'WWW-Authenticate': `Basic realm="${ADMIN_REALM}", charset="UTF-8"`,
        'Cache-Control': 'no-store',
      },
    };
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method) && isCrossSiteRequest(req.headers)) {
    return {
      allow: false,
      status: 403,
      code: 'CSRF_BLOCKED',
      error: 'Запрос с другого сайта отклонён',
      headers: { 'Cache-Control': 'no-store' },
    };
  }

  return { allow: true };
}

// ---------------------------------------------------------------------
// Адаптеры
// ---------------------------------------------------------------------

function sendDenied(res: ServerResponse, d: Extract<GuardDecision, { allow: false }>): void {
  res.statusCode = d.status;
  for (const [k, v] of Object.entries(d.headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: d.error, code: d.code }));
}

/** Express: ставится в expressApp.ts сразу после cors(), до разбора тела. */
export function adminAuthMiddleware(credsProvider: () => AdminCredentials = readAdminCredentialsFromEnv) {
  return (req: Request, res: Response, next: NextFunction) => {
    const decision = evaluateAdminAccess(
      { method: req.method, url: req.originalUrl || req.url, headers: req.headers },
      credsProvider(),
    );
    if (decision.allow) return next();
    sendDenied(res, decision);
  };
}

/**
 * Точки входа Vercel вне Express: true — можно продолжать, false — ответ уже
 * отправлен (401/403/503), дальше ничего делать не нужно.
 */
export function guardNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  credsProvider: () => AdminCredentials = readAdminCredentialsFromEnv,
): boolean {
  const decision = evaluateAdminAccess({ method: req.method, url: req.url, headers: req.headers }, credsProvider());
  if (decision.allow) return true;
  sendDenied(res, decision);
  return false;
}
