"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PUSH_IMAGE_MAX_BYTES = exports.isExpoToken = void 0;
exports.buildExpoMessage = buildExpoMessage;
exports.sendBroadcast = sendBroadcast;
exports.checkPushImage = checkPushImage;
const logger_1 = require("../utils/logger");
const fcm_service_1 = require("./fcm.service");
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
const isExpoToken = (t) => typeof t === 'string' && /^(Exponent|Expo)PushToken\[.+\]$/.test(t);
exports.isExpoToken = isExpoToken;
/** Одно сообщение Expo: без картинки поля richContent/image не добавляются вовсе. */
function buildExpoMessage(token, title, body, imageUrl, data) {
    const msg = { to: token, title, body, sound: 'default', data: { type: 'broadcast', ...(data ?? {}) } };
    if (imageUrl) {
        msg.richContent = { image: imageUrl };
        msg.data.image = imageUrl;
    }
    return msg;
}
async function sendChunk(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPO_TIMEOUT_MS);
    try {
        const res = await fetch(EXPO_PUSH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(messages),
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        const tickets = Array.isArray(data?.data) ? data.data : [];
        if (!res.ok || !tickets.length) {
            logger_1.logger.error({ status: res.status, expoError: data?.errors }, '[PushBroadcast] Ответ Expo не ok');
            return { sent: 0, failed: messages.length, notRegistered: 0 };
        }
        let sent = 0, failed = 0, notRegistered = 0;
        for (const t of tickets) {
            if (t?.status === 'ok')
                sent++;
            else {
                failed++;
                if (t?.details?.error === 'DeviceNotRegistered')
                    notRegistered++;
            }
        }
        // Билетов меньше, чем сообщений — недостающие считаем неудачными.
        failed += Math.max(0, messages.length - tickets.length);
        return { sent, failed, notRegistered };
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[PushBroadcast] Запрос к Expo упал');
        return { sent: 0, failed: messages.length, notRegistered: 0 };
    }
    finally {
        clearTimeout(timer);
    }
}
async function sendBroadcast(input) {
    const unique = Array.from(new Set(input.tokens.filter((t) => typeof t === 'string' && t.trim())));
    const expo = unique.filter(exports.isExpoToken);
    const fcm = unique.filter((t) => !(0, exports.isExpoToken)(t));
    const result = {
        total: unique.length, expoTokens: expo.length, fcmTokens: fcm.length, sent: 0, failed: 0, notRegistered: 0, withImage: !!input.imageUrl,
    };
    const chunks = [];
    for (let i = 0; i < expo.length; i += EXPO_CHUNK) {
        chunks.push(expo.slice(i, i + EXPO_CHUNK).map((t) => buildExpoMessage(t, input.title, input.body, input.imageUrl, input.data)));
    }
    for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
        const parts = await Promise.all(chunks.slice(i, i + PARALLEL_CHUNKS).map(sendChunk));
        for (const p of parts) {
            result.sent += p.sent;
            result.failed += p.failed;
            result.notRegistered += p.notRegistered;
        }
    }
    if (fcm.length) {
        const f = await (0, fcm_service_1.sendFcmBroadcast)(fcm, input.title, input.body, input.imageUrl, undefined, input.data, !!input.fullText);
        result.sent += f.sent;
        result.failed += f.failed;
        result.notRegistered += f.notRegistered;
        if (f.error)
            result.fcmError = f.error;
    }
    return result;
}
exports.PUSH_IMAGE_MAX_BYTES = 1_000_000; // Android не показывает в пуше картинки тяжелее ~1 МБ
const IMAGE_OK_TYPES = /^image\/(jpeg|jpg|png|gif|webp)\b/i;
/**
 * Проверка картинки пуша ДО отправки: доступна ли по ссылке, это ли картинка, не тяжелее ли 1 МБ.
 * Ничего не блокирует — возвращает понятное предупреждение, почему картинка может не показаться
 * (система телефона сама скачивает её по ссылке; при ошибке пуш приходит без картинки).
 */
async function checkPushImage(url) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    try {
        const res = await fetch(url, { method: 'HEAD', signal: c.signal, redirect: 'follow' });
        if (!res.ok)
            return `Картинка недоступна по ссылке (HTTP ${res.status}) — телефон не сможет её скачать, пуш придёт без картинки`;
        const type = res.headers.get('content-type') ?? '';
        if (type && !IMAGE_OK_TYPES.test(type))
            return `Ссылка ведёт не на картинку (${type.split(';')[0]}) — нужен JPG/PNG/GIF/WEBP`;
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len > exports.PUSH_IMAGE_MAX_BYTES)
            return `Картинка весит ${(len / 1e6).toFixed(1)} МБ — Android не показывает в пуше картинки тяжелее 1 МБ. Уменьши фото`;
        return null;
    }
    catch {
        return 'Не удалось проверить картинку по ссылке — убедись, что она открывается без входа';
    }
    finally {
        clearTimeout(t);
    }
}
//# sourceMappingURL=pushBroadcast.service.js.map