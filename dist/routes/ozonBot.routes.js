"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ozonBotSecret = exports.ozonBotRouter = void 0;
exports.setOzonBotTelegramFetch = setOzonBotTelegramFetch;
exports.sendOzonBot = sendOzonBot;
exports.handleOzonBotUpdate = handleOzonBotUpdate;
exports.sendOzonBotReport = sendOzonBotReport;
const express_1 = require("express");
const crypto_1 = require("crypto");
const functions_1 = require("@vercel/functions");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const ozonManager_service_1 = require("../services/ozonManager.service");
/**
 * Озон-менеджер — ОТДЕЛЬНЫЙ Telegram-бот (свой токен OZON_BOT_TOKEN), только для владельца
 * (OZON_BOT_OWNER_ID — его chat id). Вебхук: /api/ozon-bot/webhook, защита — секрет из токена.
 */
exports.ozonBotRouter = (0, express_1.Router)();
const token = () => (process.env.OZON_BOT_TOKEN ?? '').trim();
const ownerId = () => (process.env.OZON_BOT_OWNER_ID ?? '').trim();
const ozonBotSecret = () => (0, crypto_1.createHash)('sha256').update('ozon-bot:' + token()).digest('hex').slice(0, 32);
exports.ozonBotSecret = ozonBotSecret;
let tgFetch = (...a) => fetch(...a);
function setOzonBotTelegramFetch(f) { tgFetch = f ?? ((...a) => fetch(...a)); }
async function tg(method, body) {
    const r = await tgFetch(`https://api.telegram.org/bot${token()}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok)
        throw new Error(`telegram ${method}: ${data?.description ?? r.status}`);
    return data.result;
}
/** Отправить текст (HTML), длинный — кусками; если Telegram не принял разметку — тем же текстом без неё. */
async function sendOzonBot(chatId, text) {
    const parts = [];
    let rest = text;
    while (rest.length > 3900) {
        const cut = rest.lastIndexOf('\n', 3900);
        parts.push(rest.slice(0, cut > 1000 ? cut : 3900));
        rest = rest.slice(cut > 1000 ? cut : 3900);
    }
    parts.push(rest);
    for (const part of parts) {
        try {
            await tg('sendMessage', { chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true });
        }
        catch {
            await tg('sendMessage', { chat_id: chatId, text: part.replace(/<[^>]+>/g, ''), disable_web_page_preview: true });
        }
    }
}
/** Фото из Telegram → base64 для Claude (самое большое из размеров, до ~4 МБ). */
async function downloadPhoto(fileId) {
    const f = await tg('getFile', { file_id: fileId });
    const r = await tgFetch(`https://api.telegram.org/file/bot${token()}/${f.file_path}`);
    if (!r.ok)
        throw new Error(`photo ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4_500_000)
        throw new Error('фото слишком большое');
    const ext = String(f.file_path).split('.').pop()?.toLowerCase();
    return { mediaType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', base64: buf.toString('base64') };
}
function secretOk(v) {
    if (!token() || !v)
        return false;
    const a = Buffer.from(v);
    const b = Buffer.from((0, exports.ozonBotSecret)());
    return a.length === b.length && (0, crypto_1.timingSafeEqual)(a, b);
}
const money = (n) => `${Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ')} ₸`;
const HELP = [
    '<b>Озон-менеджер</b> 🤖',
    'Спрашивайте обычными словами: «сколько заработали за неделю?», «что отгрузить сегодня?», «какие возвраты?».',
    '',
    '🔎 <b>Анализ товара и конкурентов</b>: пришлите фото товара и подпись — название и себестоимость (например «Блендер Kitfort KT-1365, закупка 9500»). Найду ~10 конкурентов на Ozon, посчитаю маржу и скажу, FBO или FBS.',
    '',
    'Быстрые команды:',
    '/report — утренний отчёт (отгрузки, закупка, возвраты, склады)',
    '/today — продажи и прибыль за сегодня',
    '/ship — что отгрузить и сроки',
    '/buy — сколько нужно на закупку',
    '/returns — возвраты за 7 дней',
    '/stock — остатки на складах Ozon',
    '/new — начать разговор заново',
].join('\n');
async function quick(cmd) {
    switch (cmd) {
        case '/report': return (0, ozonManager_service_1.morningReport)();
        case '/evening': return (0, ozonManager_service_1.eveningReport)();
        case '/today': {
            const d = await (0, ozonManager_service_1.daySales)();
            return [`<b>Сегодня (${d.date})</b>`, `FBS: ${d.fbs.orders} заказов на ${money(d.fbs.revenue)}, прибыль ≈ <b>${money(d.fbs.profit)}</b>`,
                d.fbo.count ? `FBO: ${d.fbo.count} на ${money(d.fbo.revenue)}` : '', d.cancelled ? `Отмен: ${d.cancelled}` : '',
                ...d.fbs.list.slice(0, 15).map((x) => `• ${x.posting}: ${money(x.revenue)} → ${money(x.profit)}${x.feesPending ? ' (комиссия ещё не начислена)' : ''}`)]
                .filter(Boolean).join('\n');
        }
        case '/ship': {
            const s = await (0, ozonManager_service_1.fbsToShip)();
            return [`<b>Отгрузка FBS</b>: ${s.total} (просрочено ${s.overdue}, сегодня ${s.today}, завтра ${s.tomorrow})`,
                ...s.postings.slice(0, 25).map((p) => `${p.bucket === 'overdue' ? '🔴' : p.bucket === 'today' ? '🟠' : '•'} ${p.postingNumber} — до ${p.shipBy ? new Date(p.shipBy).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}${p.needPacking ? ', не собран' : ', сдать'}`)].join('\n');
        }
        case '/buy': {
            const b = await (0, ozonManager_service_1.purchaseNeeds)();
            return [`<b>Закупка под заказы</b>: ${money(b.totalPurchase)}`,
                ...b.items.slice(0, 25).map((i) => `• ${i.name.slice(0, 60)} — ${i.qty} шт${i.unitCost ? ` × ${money(i.unitCost)} = ${money(i.sum)}` : ' (нет закупочной цены)'}`)].join('\n');
        }
        case '/returns': {
            const r = await (0, ozonManager_service_1.returnsList)(7);
            return [`<b>Возвраты за 7 дней</b>: ${r.count} на ${money(r.sum)}`,
                ...r.items.slice(0, 20).map((x) => `• ${x.product.slice(0, 50)} — ${x.status}${x.reason ? `, ${x.reason}` : ''}`)].join('\n');
        }
        case '/stock': {
            const s = await (0, ozonManager_service_1.fboStock)();
            return [`<b>Склады Ozon</b>: ${s.skus} товаров, ${s.totalFree} шт`, `Кончается (≤7 дней): ${s.lowCount}`,
                ...s.low.map((x) => `• ${x.name.slice(0, 50)} — ${x.free} шт, ~${x.daysLeft} дн.`),
                s.outOfStockSelling.length ? `Закончились: ${s.outOfStockSelling.join(', ')}` : ''].filter(Boolean).join('\n');
        }
        default: return null;
    }
}
async function handleOzonBotUpdate(update) {
    const msg = update?.message;
    const chatId = msg?.chat?.id != null ? String(msg.chat.id) : '';
    const text = String(msg?.text ?? msg?.caption ?? '').trim();
    const photo = Array.isArray(msg?.photo) ? msg.photo : undefined;
    if (!chatId || (!text && !photo?.length))
        return;
    if (!ownerId()) {
        await sendOzonBot(chatId, `Бот ещё не привязан к владельцу.\nВаш chat id: <b>${chatId}</b>\nДобавьте его в Vercel как OZON_BOT_OWNER_ID и сделайте Redeploy.`);
        return;
    }
    if (chatId !== ownerId())
        return; // чужим — молчим
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/start' || cmd === '/help') {
        await sendOzonBot(chatId, HELP);
        return;
    }
    if (cmd === '/new') {
        await prisma_1.prisma.ozonBotMessage.deleteMany({ where: { chatId } });
        await sendOzonBot(chatId, 'Начали заново 👍');
        return;
    }
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
    try {
        const fast = await quick(cmd);
        if (fast !== null) {
            await sendOzonBot(chatId, fast);
            return;
        }
        const rows = await prisma_1.prisma.ozonBotMessage.findMany({ where: { chatId }, orderBy: { createdAt: 'desc' }, take: 10 });
        const history = rows.reverse().map((r) => ({ role: r.role, content: r.content }));
        const image = photo?.length ? await downloadPhoto(photo[photo.length - 1].file_id).catch(() => undefined) : undefined;
        if (photo?.length)
            await sendOzonBot(chatId, '🔎 Смотрю товар и ищу конкурентов на Ozon — это займёт до минуты…');
        const answer = await (0, ozonManager_service_1.askOzonManager)(history, text, image);
        await prisma_1.prisma.ozonBotMessage.createMany({ data: [{ chatId, role: 'user', content: ((photo?.length ? '[фото товара] ' : '') + text).slice(0, 4000) }, { chatId, role: 'assistant', content: answer.slice(0, 4000) }] });
        await sendOzonBot(chatId, answer);
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[OzonBot] ошибка ответа');
        await sendOzonBot(chatId, `⚠️ Не получилось: ${String(err?.message ?? err).slice(0, 200)}`).catch(() => undefined);
    }
}
exports.ozonBotRouter.post('/webhook', (req, res) => {
    if (!secretOk(req.header('x-telegram-bot-api-secret-token')))
        return res.status(401).json({ ok: false });
    res.json({ ok: true }); // Telegram ждёт быстрый ответ; думаем в фоне
    (0, functions_1.waitUntil)(handleOzonBotUpdate(req.body).catch((err) => logger_1.logger.error({ err: String(err?.message ?? err) }, '[OzonBot] webhook')));
});
/** Админский: один раз привязать бота к этому серверу (setWebhook) и задать меню команд. */
exports.ozonBotRouter.get('/setup', async (req, res) => {
    if (!token())
        return res.status(503).json({ error: 'OZON_BOT_TOKEN не настроен в Vercel' });
    const host = req.header('x-forwarded-host') || req.header('host');
    const url = `https://${host}/api/ozon-bot/webhook`;
    try {
        await tg('setWebhook', { url, secret_token: (0, exports.ozonBotSecret)(), allowed_updates: ['message'], drop_pending_updates: true });
        await tg('setMyCommands', { commands: [
                { command: 'report', description: 'Утренний отчёт' }, { command: 'today', description: 'Продажи за сегодня' },
                { command: 'ship', description: 'Что отгрузить' }, { command: 'buy', description: 'Закупка под заказы' },
                { command: 'returns', description: 'Возвраты' }, { command: 'stock', description: 'Склады Ozon' }, { command: 'new', description: 'Начать заново' },
            ] }).catch(() => undefined);
        res.json({ ok: true, webhook: url, owner: ownerId() ? 'задан' : 'не задан — напишите боту /start, он пришлёт ваш chat id' });
    }
    catch (err) {
        res.status(502).json({ error: 'Не удалось подключить бота', details: String(err?.message ?? err) });
    }
});
/** Отчёт владельцу (утро/вечер) — зовёт крон. */
async function sendOzonBotReport(kind) {
    if (!token() || !ownerId())
        return { sent: false, reason: 'not_configured' };
    const text = kind === 'morning' ? await (0, ozonManager_service_1.morningReport)() : await (0, ozonManager_service_1.eveningReport)();
    await sendOzonBot(ownerId(), text);
    return { sent: true };
}
//# sourceMappingURL=ozonBot.routes.js.map