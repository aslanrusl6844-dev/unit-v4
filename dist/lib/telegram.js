"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTelegramTestMessage = sendTelegramTestMessage;
exports.sendOrderNotify = sendOrderNotify;
exports.editOrderNotify = editOrderNotify;
const prisma_1 = require("../db/prisma");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const TELEGRAM_TIMEOUT_MS = 5000;
function chatIds() {
    return env_1.env.telegramChatIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function parseItems(itemsJson) {
    try {
        const items = JSON.parse(itemsJson);
        return Array.isArray(items) ? items : [];
    }
    catch {
        return [];
    }
}
function formatAddress(order) {
    return [order.city, order.street, order.house, order.apartment ? `кв. ${order.apartment}` : ''].filter(Boolean).join(', ');
}
function formatMoney(n) {
    return `${Math.round(n).toLocaleString('ru-RU')} ₸`;
}
/**
 * Текст сообщения: номер, каждая позиция (название · N шт · сумма позиции),
 * итого, адрес, телефон, статус. strikethrough — для отменённого заказа
 * зачёркивает номер и позиции (Telegram HTML, <s>…</s>); наверх добавляется
 * «ОТМЕНЁН». statusLine — что показать вместо «ожидает оплату» при правке.
 */
function buildOrderMessage(order, opts) {
    const items = parseItems(order.items);
    const numberLine = `№ ${escapeHtml(order.number)}`;
    const itemLines = items.map((i) => {
        const line = `${escapeHtml(i.name)} · ${i.quantity} шт · ${formatMoney(i.price * i.quantity)}`;
        return opts.cancelled ? `<s>${line}</s>` : line;
    });
    const lines = [];
    if (opts.cancelled)
        lines.push('❌ <b>ОТМЕНЁН</b>', '');
    else
        lines.push('🛒 <b>My Market · новый заказ</b>');
    lines.push(opts.cancelled ? `<s>${numberLine}</s>` : numberLine, '');
    lines.push(...itemLines, '');
    lines.push(`Итого: ${formatMoney(order.total)}`, '');
    lines.push(escapeHtml(formatAddress(order)));
    lines.push(escapeHtml(order.phone));
    // Для отменённого заказа статус-строку внизу не дублируем — сверху уже
    // «ОТМЕНЁН», а «ожидает оплату»/«Оплачен» здесь были бы прямым противоречием.
    if (!opts.cancelled) {
        lines.push('', `Статус: ${opts.statusLine}`);
    }
    return lines.join('\n');
}
/** Первый «нормальный» url из images (https:// или http://). http://
 *  сразу приводим к https:// той же ссылкой — Telegram надёжнее работает
 *  с https, а домен обычно отдаёт то же самое по обеим схемам. */
function firstNormalImageUrl(images) {
    if (!Array.isArray(images))
        return null;
    const first = images.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim()));
    if (!first)
        return null;
    return first.trim().replace(/^http:\/\//i, 'https://');
}
/** Картинка первого товара заказа — по sku ИЛИ shopArticle позиции (та же
 *  логика поиска товара по заказу, что и при оплате). */
async function firstItemImageUrl(order) {
    const items = parseItems(order.items);
    const firstSku = items[0]?.sku;
    if (!firstSku)
        return null;
    try {
        const product = await prisma_1.prisma.product.findFirst({ where: { OR: [{ sku: firstSku }, { shopArticle: firstSku }] } });
        if (!product?.images)
            return null;
        return firstNormalImageUrl(JSON.parse(product.images));
    }
    catch {
        return null;
    }
}
async function telegramApi(method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    try {
        const res = await fetch(`https://api.telegram.org/bot${env_1.env.telegramBotToken}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
            logger_1.logger.error({ method, status: res.status, telegramError: data?.description }, '[Telegram] Ответ API не ok');
            return { ok: false };
        }
        return { ok: true, result: data.result };
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err), method }, '[Telegram] Запрос не выполнен (сеть/таймаут)');
        return { ok: false };
    }
    finally {
        clearTimeout(timer);
    }
}
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10000;
/**
 * Скачивает картинку товара сами, если Telegram не смог забрать её по url
 * (бывает: сервер отдаёт картинку не всем ботам/CDN блокирует, домен без
 * валидного SSL и т.п.). Таймаут 10с — на скачивание, отдельно от таймаута
 * запросов к самому Telegram. Токен здесь ни при чём, но на всякий случай:
 * в лог идёт только url картинки, не сам файл и не токен бота.
 */
async function downloadImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            logger_1.logger.error({ status: res.status, url }, '[Telegram] Не удалось скачать картинку товара (ответ не ok)');
            return null;
        }
        const arrayBuffer = await res.arrayBuffer();
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        return { buffer: Buffer.from(arrayBuffer), contentType };
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err), url }, '[Telegram] Не удалось скачать картинку товара (сеть/таймаут)');
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/** sendPhoto файлом (multipart) — когда Telegram не смог забрать картинку
 *  сам по url. Токен только в URL запроса, в лог не попадает нигде. */
async function sendPhotoFile(chatId, image, caption) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    try {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');
        form.append('photo', new Blob([image.buffer], { type: image.contentType }), 'photo.jpg');
        const res = await fetch(`https://api.telegram.org/bot${env_1.env.telegramBotToken}/sendPhoto`, {
            method: 'POST',
            body: form,
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
            logger_1.logger.error({ status: res.status, telegramError: data?.description }, '[Telegram] sendPhoto файлом — ответ не ok');
            return { ok: false };
        }
        return { ok: true, result: data.result };
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[Telegram] sendPhoto файлом не выполнен');
        return { ok: false };
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Служебная проверка настройки Telegram — шлёт одну строку во все настроенные
 * чаты. Токен нигде не возвращается и не логируется (у telegramApi тоже).
 * Нет TELEGRAM_BOT_TOKEN — сразу { ok:false, error:'no_token' }, без попытки
 * достучаться до API.
 */
async function sendTelegramTestMessage() {
    const ids = chatIds();
    if (!env_1.env.telegramBotToken)
        return { ok: false, chatCount: ids.length, error: 'no_token' };
    if (!ids.length)
        return { ok: false, chatCount: 0, error: 'no_chat_ids' };
    let successCount = 0;
    for (const chatId of ids) {
        const res = await telegramApi('sendMessage', { chat_id: chatId, text: 'My Market тест' });
        if (res.ok)
            successCount += 1;
    }
    return successCount > 0
        ? { ok: true, chatCount: ids.length }
        : { ok: false, chatCount: ids.length, error: 'send_failed' };
}
/**
 * Новое сообщение о заказе — одно на chat_id, photo если есть https-картинка
 * первого товара, иначе просто текст. message_id по каждому chat_id
 * сохраняется в ShopOrder.telegramMessages, чтобы потом править то же
 * сообщение (editOrderNotify), а не слать новое. Нет TELEGRAM_BOT_TOKEN —
 * молча ничего не делает. Любая ошибка — только в лог, заказ уже создан
 * до вызова этой функции и её результат на это никак не влияет.
 */
async function sendOrderNotify(order) {
    const ids = chatIds();
    // Диагностика в лог — без самого токена и без chat_id, только факт
    // настройки: пусто в логах Vercel (как в отчёте) означает, что до сюда
    // даже не доходит — значит, дело раньше (роут/деплой), а не в самом Telegram.
    logger_1.logger.info({ tokenSet: !!env_1.env.telegramBotToken, chatIdsCount: ids.length }, '[Telegram] sendOrderNotify старт');
    if (!env_1.env.telegramBotToken)
        return;
    if (!ids.length)
        return;
    try {
        const caption = buildOrderMessage(order, { statusLine: 'ожидает оплату' });
        const photoUrl = await firstItemImageUrl(order);
        // Скачиваем картинку САМИ только если sendPhoto по url не удался хотя бы
        // раз — и только один раз на все чаты (картинка у всех получателей одна
        // и та же), а не заново на каждый chat_id.
        let downloadedImage;
        const sent = [];
        for (const chatId of ids) {
            let res;
            let isPhoto = false;
            if (photoUrl) {
                res = await telegramApi('sendPhoto', { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' });
                if (res.ok) {
                    isPhoto = true;
                }
                else {
                    // Telegram не смог забрать картинку по url — скачиваем сами и шлём файлом.
                    if (downloadedImage === undefined)
                        downloadedImage = await downloadImage(photoUrl);
                    if (downloadedImage) {
                        res = await sendPhotoFile(chatId, downloadedImage, caption);
                        isPhoto = res.ok;
                    }
                    // И файл не ушёл (или скачать не получилось) — как раньше: просто текстом.
                    if (!res.ok) {
                        res = await telegramApi('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML' });
                        isPhoto = false;
                    }
                }
            }
            else {
                res = await telegramApi('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML' });
            }
            if (res.ok && res.result)
                sent.push({ chatId, messageId: res.result.message_id, isPhoto });
        }
        if (sent.length) {
            await prisma_1.prisma.shopOrder.update({ where: { id: order.id }, data: { telegramMessages: JSON.stringify(sent) } });
        }
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err), orderId: order.id }, '[Telegram] sendOrderNotify упал');
    }
}
/**
 * Правит уже отправленное сообщение (по сохранённым message_id) вместо
 * отправки нового — статус paid показывает «Оплачен», cancelled зачёркивает
 * номер и позиции и добавляет «ОТМЕНЁН» сверху. Молча ничего не делает без
 * токена или если для заказа не сохранено ни одного message_id (например,
 * сообщение при создании не отправилось). Ошибки — только в лог.
 */
async function editOrderNotify(order, status) {
    if (!env_1.env.telegramBotToken)
        return;
    if (!order.telegramMessages)
        return;
    let refs = [];
    try {
        refs = JSON.parse(order.telegramMessages);
        if (!Array.isArray(refs))
            refs = [];
    }
    catch {
        refs = [];
    }
    if (!refs.length)
        return;
    try {
        const text = status === 'cancelled'
            ? buildOrderMessage(order, { statusLine: '', cancelled: true })
            : buildOrderMessage(order, { statusLine: '✅ Оплачен' });
        for (const ref of refs) {
            if (ref.isPhoto) {
                await telegramApi('editMessageCaption', { chat_id: ref.chatId, message_id: ref.messageId, caption: text, parse_mode: 'HTML' });
            }
            else {
                await telegramApi('editMessageText', { chat_id: ref.chatId, message_id: ref.messageId, text, parse_mode: 'HTML' });
            }
        }
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err), orderId: order.id, status }, '[Telegram] editOrderNotify упал');
    }
}
//# sourceMappingURL=telegram.js.map