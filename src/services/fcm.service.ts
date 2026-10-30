import { createSign } from 'node:crypto';
import { logger } from '../utils/logger';

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

export interface ServiceAccount { project_id: string; client_email: string; private_key: string }
export class FcmConfigError extends Error {}

/** Разбор FIREBASE_KEY. Бросает FcmConfigError с понятным текстом (без значения ключа). */
export function parseFirebaseKey(raw: string | undefined): ServiceAccount {
  const v = (raw ?? '').trim();
  if (!v) throw new FcmConfigError('Переменная FIREBASE_KEY не задана');
  const tryJson = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryJson(v);
  if (!obj) {
    try { obj = tryJson(Buffer.from(v, 'base64').toString('utf8')); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object' || !obj.client_email || !obj.private_key || !obj.project_id) {
    throw new FcmConfigError('FIREBASE_KEY должен быть JSON сервисного аккаунта Firebase (project_id, client_email, private_key). Старый server key не поддерживается Google.');
  }
  return { project_id: String(obj.project_id), client_email: String(obj.client_email), private_key: String(obj.private_key).replace(/\\n/g, '\n') };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

export function signJwt(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key);
  return `${head}.${claim}.${b64url(sig)}`;
}

let cached: { token: string; exp: number; key: string } | null = null;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), FCM_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cached && cached.key === sa.client_email && cached.exp - 60_000 > now) return cached.token;
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa) }).toString(),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    logger.error({ status: res.status, error: data?.error }, '[FCM] Не удалось получить access token');
    throw new FcmConfigError(`Google не выдал токен доступа (${data?.error ?? res.status}) — проверь, что FIREBASE_KEY — действующий ключ сервисного аккаунта`);
  }
  cached = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) * 1000, key: sa.client_email };
  return cached.token;
}

/** Сообщение FCM v1. Без картинки полей image нет вовсе. */
export function buildFcmMessage(token: string, title: string, body: string, imageUrl?: string | null, data?: Record<string, string>, fullText = false) {
  if (fullText) {
    // «Весь текст»: Android показывает уведомление с картинкой урезанным, а систему не настроить.
    // Поэтому Android получает только data (title/body/image) и приложение само рисует баннер
    // с полным текстом; iOS получает обычный alert.
    const msg: Record<string, any> = {
      token,
      data: { type: 'broadcast', ...(data ?? {}), title, body, ...(imageUrl ? { image: imageUrl } : {}) },
      android: { priority: 'HIGH' },
      apns: { payload: { aps: { alert: { title, body }, sound: 'default', ...(imageUrl ? { 'mutable-content': 1 } : {}) } }, ...(imageUrl ? { fcm_options: { image: imageUrl } } : {}) },
    };
    return msg;
  }
  const notification: Record<string, string> = { title, body };
  const message: Record<string, any> = { token, notification, data: { type: 'broadcast', ...(data ?? {}) } };
  if (imageUrl) {
    notification.image = imageUrl;
    message.data.image = imageUrl;
    message.android = { notification: { image: imageUrl } };
    message.apns = { payload: { aps: { 'mutable-content': 1 } }, fcm_options: { image: imageUrl } };
  }
  return message;
}

export interface FcmResult { sent: number; failed: number; notRegistered: number; error?: string }

export async function sendFcmBroadcast(tokens: string[], title: string, body: string, imageUrl?: string | null, rawKey = process.env.FIREBASE_KEY, extraData?: Record<string, string>, fullText = false): Promise<FcmResult> {
  const result: FcmResult = { sent: 0, failed: 0, notRegistered: 0 };
  if (!tokens.length) return result;
  let sa: ServiceAccount;
  let access: string;
  try {
    sa = parseFirebaseKey(rawKey);
    access = await getAccessToken(sa);
  } catch (err: any) {
    result.failed = tokens.length;
    result.error = err instanceof FcmConfigError ? err.message : 'Не удалось подключиться к Firebase';
    return result;
  }
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
  const one = async (token: string) => {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: buildFcmMessage(token, title, body, imageUrl, extraData, fullText) }),
      });
      if (res.ok) { result.sent++; return; }
      const data: any = await res.json().catch(() => ({}));
      result.failed++;
      const code = String(data?.error?.status ?? '');
      const detail = JSON.stringify(data?.error?.details ?? '');
      if (code === 'NOT_FOUND' || detail.includes('UNREGISTERED')) result.notRegistered++;
      else if (res.status === 401 || res.status === 403) result.error = result.error ?? `Firebase отказал в доступе (${res.status}): проверь права сервисного аккаунта`;
    } catch (err: any) {
      result.failed++;
      logger.error({ err: String(err?.message ?? err) }, '[FCM] Запрос упал');
    }
  };
  for (let i = 0; i < tokens.length; i += FCM_PARALLEL) await Promise.all(tokens.slice(i, i + FCM_PARALLEL).map(one));
  return result;
}

/** Только для тестов. */
export function _resetFcmCache() { cached = null; }
