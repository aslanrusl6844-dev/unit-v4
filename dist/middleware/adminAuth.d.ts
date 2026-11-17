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
export declare const ADMIN_REALM = "unit-v4 admin";
export declare const ADMIN_MIN_PASSWORD_LENGTH = 12;
export interface AdminCredentials {
    user: string;
    password: string;
}
export interface GuardRequest {
    method?: string;
    url?: string;
    headers: IncomingMessage['headers'];
}
export type GuardDecision = {
    allow: true;
} | {
    allow: false;
    status: 401 | 403 | 503;
    code: 'ADMIN_AUTH_REQUIRED' | 'ADMIN_AUTH_NOT_CONFIGURED' | 'CSRF_BLOCKED';
    error: string;
    headers: Record<string, string>;
};
/** Читается на КАЖДЫЙ запрос (а не при загрузке модуля): Vercel подставляет env до старта, но тесты и смена значений так работают без перезагрузки. */
export declare function readAdminCredentialsFromEnv(): AdminCredentials;
export declare function credentialsAreUsable(c: AdminCredentials): boolean;
/**
 * Приводит строку запроса к виду, в котором её можно сравнивать со списком
 * публичных путей. Возвращает null, если разобрать адрес нельзя — такой запрос
 * считается защищённым.
 */
export declare function normalizeRequestPath(rawUrl: string | undefined): string | null;
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
export declare function isPublicApiPath(path: string): boolean;
/** true — запрос пришёл со страницы другого сайта/поддомена (или происхождение неопределимо). */
export declare function isCrossSiteRequest(headers: IncomingMessage['headers']): boolean;
export declare function evaluateAdminAccess(req: GuardRequest, creds?: AdminCredentials): GuardDecision;
/** Express: ставится в expressApp.ts сразу после cors(), до разбора тела. */
export declare function adminAuthMiddleware(credsProvider?: () => AdminCredentials): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Точки входа Vercel вне Express: true — можно продолжать, false — ответ уже
 * отправлен (401/403/503), дальше ничего делать не нужно.
 */
export declare function guardNodeRequest(req: IncomingMessage, res: ServerResponse, credsProvider?: () => AdminCredentials): boolean;
