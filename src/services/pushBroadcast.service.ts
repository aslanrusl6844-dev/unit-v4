import { logger } from '../utils/logger';
import { sendFcmBroadcast } from './fcm.service';

/**
 * Рассылка пушей. Канал выбирается по формату токена:
 *  - ExponentPushToken[...] → Expo Push API (картинка: richContent.image + data.image);
 *  - любой другой (FCM-токен устройства) → Firebase Cloud Messaging напрямую
 *    (fcm.service.ts, ключ FIREBASE_KEY; картинка: notification.image и т.д.).
 * Картинка необязательна: без неё сообщение уходит как обычное.
 */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_CHUNK = 100; // лимит Expo на одну отправку
const EXPO_TIMEOUT_MS = 8000;
const PARALLEL_CHUNKS = 4;

export const isExpoToken = (t: unknown): t is string => typeof t === 'string' && /^(Exponent|Expo)PushToken\[.+\]$/.test(t);

export interface BroadcastInput {
  title: string;
  body: string;
  imageUrl?: string | null;
  tokens: string[];
}
export interface BroadcastResult {
  total: number; // токенов получено
  expoTokens: number; // ушло через Expo
  fcmTokens: number; // ушло через Firebase напрямую
  sent: number; // принято (Expo + Firebase)
  failed: number; // ошибка по токену или запрос не прошёл
  notRegistered: number; // из failed: устройство больше не зарегистрировано
  withImage: boolean;
  fcmError?: string; // причина, если Firebase недоступен (ключ не задан/неверный/нет прав)
}

/** Одно сообщение Expo: без картинки поля richContent/image не добавляются вовсе. */
export function buildExpoMessage(token: string, title: string, body: string, imageUrl?: string | null) {
  const msg: Record<string, unknown> = { to: token, title, body, sound: 'default', data: { type: 'broadcast' } };
  if (imageUrl) {
    msg.richContent = { image: imageUrl };
    (msg.data as Record<string, unknown>).image = imageUrl;
  }
  return msg;
}

async function sendChunk(messages: Record<string, unknown>[]): Promise<{ sent: number; failed: number; notRegistered: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPO_TIMEOUT_MS);
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
      signal: controller.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    const tickets: any[] = Array.isArray(data?.data) ? data.data : [];
    if (!res.ok || !tickets.length) {
      logger.error({ status: res.status, expoError: data?.errors }, '[PushBroadcast] Ответ Expo не ok');
      return { sent: 0, failed: messages.length, notRegistered: 0 };
    }
    let sent = 0, failed = 0, notRegistered = 0;
    for (const t of tickets) {
      if (t?.status === 'ok') sent++;
      else {
        failed++;
        if (t?.details?.error === 'DeviceNotRegistered') notRegistered++;
      }
    }
    // Билетов меньше, чем сообщений — недостающие считаем неудачными.
    failed += Math.max(0, messages.length - tickets.length);
    return { sent, failed, notRegistered };
  } catch (err: any) {
    logger.error({ err: String(err?.message ?? err) }, '[PushBroadcast] Запрос к Expo упал');
    return { sent: 0, failed: messages.length, notRegistered: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendBroadcast(input: BroadcastInput): Promise<BroadcastResult> {
  const unique = Array.from(new Set(input.tokens.filter((t) => typeof t === 'string' && t.trim())));
  const expo = unique.filter(isExpoToken);
  const fcm = unique.filter((t) => !isExpoToken(t));
  const result: BroadcastResult = {
    total: unique.length, expoTokens: expo.length, fcmTokens: fcm.length, sent: 0, failed: 0, notRegistered: 0, withImage: !!input.imageUrl,
  };
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < expo.length; i += EXPO_CHUNK) {
    chunks.push(expo.slice(i, i + EXPO_CHUNK).map((t) => buildExpoMessage(t, input.title, input.body, input.imageUrl)));
  }
  for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
    const parts = await Promise.all(chunks.slice(i, i + PARALLEL_CHUNKS).map(sendChunk));
    for (const p of parts) { result.sent += p.sent; result.failed += p.failed; result.notRegistered += p.notRegistered; }
  }
  if (fcm.length) {
    const f = await sendFcmBroadcast(fcm, input.title, input.body, input.imageUrl);
    result.sent += f.sent; result.failed += f.failed; result.notRegistered += f.notRegistered;
    if (f.error) result.fcmError = f.error;
  }
  return result;
}
