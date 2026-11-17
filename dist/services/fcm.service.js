"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FcmConfigError = void 0;
exports.parseFirebaseKey = parseFirebaseKey;
exports.signJwt = signJwt;
exports.buildFcmMessage = buildFcmMessage;
exports.sendFcmBroadcast = sendFcmBroadcast;
exports._resetFcmCache = _resetFcmCache;
const node_crypto_1 = require("node:crypto");
const logger_1 = require("../utils/logger");
/**
 * Прямая отправка пушей через Firebase Cloud Messaging HTTP v1 (без Expo).
 * Ключ — FIREBASE_KEY: JSON сервисного аккаунта Firebase (можно целиком, либо
 * base64 от этого JSON). Старый «server key» FCM Google отключил — он не
 * подходит. Ни ключ, ни токены в логи не пишутся.
 *
 * Зависимостей не добавляем: OAuth2-токен получаем подписью JWT (RS256) через
 * node:crypto и обычный fetch.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_TIMEOUT_MS = 8000;
const FCM_PARALLEL = 20;
class FcmConfigError extends Error {
}
exports.FcmConfigError = FcmConfigError;
/** Разбор FIREBASE_KEY. Бросает FcmConfigError с понятным текстом (без значения ключа). */
function parseFirebaseKey(raw) {
    const v = (raw ?? '').trim();
    if (!v)
        throw new FcmConfigError('Переменная FIREBASE_KEY не задана');
    const tryJson = (s) => { try {
        return JSON.parse(s);
    }
    catch {
        return null;
    } };
    let obj = tryJson(v);
    if (!obj) {
        try {
            obj = tryJson(Buffer.from(v, 'base64').toString('utf8'));
        }
        catch {
            obj = null;
        }
    }
    if (!obj || typeof obj !== 'object' || !obj.client_email || !obj.private_key || !obj.project_id) {
        throw new FcmConfigError('FIREBASE_KEY должен быть JSON сервисного аккаунта Firebase (project_id, client_email, private_key). Старый server key не поддерживается Google.');
    }
    return { project_id: String(obj.project_id), client_email: String(obj.client_email), private_key: String(obj.private_key).replace(/\\n/g, '\n') };
}
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function signJwt(sa, nowSec = Math.floor(Date.now() / 1000)) {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
    const sig = (0, node_crypto_1.createSign)('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key);
    return `${head}.${claim}.${b64url(sig)}`;
}
let cached = null;
async function fetchWithTimeout(url, init) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), FCM_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: c.signal });
    }
    finally {
        clearTimeout(t);
    }
}
async function getAccessToken(sa) {
    const now = Date.now();
    if (cached && cached.key === sa.client_email && cached.exp - 60_000 > now)
        return cached.token;
    const res = await fetchWithTimeout(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa) }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.access_token) {
        logger_1.logger.error({ status: res.status, error: data?.error }, '[FCM] Не удалось получить access token');
        throw new FcmConfigError(`Google не выдал токен доступа (${data?.error ?? res.status}) — проверь, что FIREBASE_KEY — действующий ключ сервисного аккаунта`);
    }
    cached = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) * 1000, key: sa.client_email };
    return cached.token;
}
/** Сообщение FCM v1. Без картинки полей image нет вовсе. */
function buildFcmMessage(token, title, body, imageUrl, data, fullText = false) {
    if (fullText) {
        // «Весь текст»: Android показывает уведомление с картинкой урезанным, а систему не настроить.
        // Поэтому Android получает только data (title/body/image) и приложение само рисует баннер
        // с полным текстом; iOS получает обычный alert.
        const msg = {
            token,
            data: { type: 'broadcast', ...(data ?? {}), title, body, ...(imageUrl ? { image: imageUrl } : {}) },
            android: { priority: 'HIGH' },
            apns: { payload: { aps: { alert: { title, body }, sound: 'default', ...(imageUrl ? { 'mutable-content': 1 } : {}) } }, ...(imageUrl ? { fcm_options: { image: imageUrl } } : {}) },
        };
        return msg;
    }
    const notification = { title, body };
    const message = { token, notification, data: { type: 'broadcast', ...(data ?? {}) } };
    if (imageUrl) {
        notification.image = imageUrl;
        message.data.image = imageUrl;
        message.android = { notification: { image: imageUrl } };
        message.apns = { payload: { aps: { 'mutable-content': 1 } }, fcm_options: { image: imageUrl } };
    }
    return message;
}
async function sendFcmBroadcast(tokens, title, body, imageUrl, rawKey = process.env.FIREBASE_KEY, extraData, fullText = false) {
    const result = { sent: 0, failed: 0, notRegistered: 0 };
    if (!tokens.length)
        return result;
    let sa;
    let access;
    try {
        sa = parseFirebaseKey(rawKey);
        access = await getAccessToken(sa);
    }
    catch (err) {
        result.failed = tokens.length;
        result.error = err instanceof FcmConfigError ? err.message : 'Не удалось подключиться к Firebase';
        return result;
    }
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
    const one = async (token) => {
        try {
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: buildFcmMessage(token, title, body, imageUrl, extraData, fullText) }),
            });
            if (res.ok) {
                result.sent++;
                return;
            }
            const data = await res.json().catch(() => ({}));
            result.failed++;
            const code = String(data?.error?.status ?? '');
            const detail = JSON.stringify(data?.error?.details ?? '');
            logger_1.logger.warn({ httpStatus: res.status, fcmStatus: code, fcmMessage: data?.error?.message }, '[FCM] Сообщение не принято');
            if (code === 'NOT_FOUND' || detail.includes('UNREGISTERED'))
                result.notRegistered++;
            else if (res.status === 401 || res.status === 403)
                result.error = result.error ?? `Firebase отказал в доступе (${res.status}): проверь права сервисного аккаунта`;
        }
        catch (err) {
            result.failed++;
            logger_1.logger.error({ err: String(err?.message ?? err) }, '[FCM] Запрос упал');
        }
    };
    for (let i = 0; i < tokens.length; i += FCM_PARALLEL)
        await Promise.all(tokens.slice(i, i + FCM_PARALLEL).map(one));
    return result;
}
/** Только для тестов. */
function _resetFcmCache() { cached = null; }
//# sourceMappingURL=fcm.service.js.map