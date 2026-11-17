"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IDLE_TEXT = exports.IDLE_MS = exports.MAX_TEXT = void 0;
exports.setSupportBaseUrl = setSupportBaseUrl;
exports.isOperatorRequest = isOperatorRequest;
exports.idleExpired = idleExpired;
exports.closeIfIdle = closeIfIdle;
exports.runIdleCheck = runIdleCheck;
exports.startChat = startChat;
exports.customerMessage = customerMessage;
exports.chatState = chatState;
exports.closeByCustomer = closeByCustomer;
exports.handleSupportUpdate = handleSupportUpdate;
/**
 * Чат с живым оператором из чата Баурсака.
 *
 * Покупатель в приложении второй раз просит оператора → приложение открывает чат поддержки (POST /start).
 * Оператору в Telegram (тот же бот, разрешённые чаты TELEGRAM_CHAT_IDS) приходит запрос с кнопками
 * «Взять» / «Завершить». Оператор отвечает реплаем на сообщение чата (или «#номер текст») —
 * ответ попадает в приложение покупателю, приходит пуш «Оператор ответил».
 * «Завершить» — чат закрывается, дальше снова отвечает Баурсак.
 */
const crypto_1 = require("crypto");
const functions_1 = require("@vercel/functions");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const telegramBot_1 = require("../lib/telegramBot");
const pushBroadcast_service_1 = require("./pushBroadcast.service");
exports.MAX_TEXT = 2000;
/** Клиент не ответил столько после сообщения оператора — чат с оператором закрывается сам. */
exports.IDLE_MS = 60_000;
exports.IDLE_TEXT = 'Чат с оператором завершён: вы не ответили в течение минуты. Если вопрос остался — напишите, Баурсак на связи 🙂';
let baseUrl = '';
/** Адрес этого же сервера (ставит вебхук бота) — для проверки «клиент молчит минуту» отдельным вызовом. */
function setSupportBaseUrl(url) { if (url)
    baseUrl = url; }
/** Просит ли клиент живого человека. Приложение соединяет только со второй такой просьбы. */
function isOperatorRequest(text) {
    const t = text.toLowerCase();
    return /оператор|менеджер|живо(й|го|му) (человек|сотрудник|консультант)|соедини|позовите|поддержк|operator|support|human|оператормен|қолдау/.test(t);
}
function cleanText(raw) {
    return String(raw ?? '').replace(/\r/g, '').trim().slice(0, exports.MAX_TEXT);
}
function who(chat) {
    const name = chat.customerName?.trim();
    const phone = chat.phone?.trim();
    return [name, phone ? `+${phone.replace(/^\+/, '')}` : ''].filter(Boolean).join(' · ') || 'Гость';
}
const takeButtons = (id) => [[
        { text: '✋ Взять', callback_data: `sup:take:${id}` },
        { text: '✖️ Завершить', callback_data: `sup:close:${id}` },
    ]];
const closeButtons = (id) => [[{ text: '✖️ Завершить чат', callback_data: `sup:close:${id}` }]];
/** Отправляет сообщение операторам и запоминает его id, чтобы ловить ответы реплаем. */
async function notifyOperators(chatId, text, targets, buttons) {
    for (const tg of targets) {
        try {
            const messageId = await (0, telegramBot_1.sendMessageWithId)(tg, text, buttons);
            if (messageId)
                await prisma_1.prisma.supportTgRef.create({ data: { supportChatId: chatId, tgChatId: tg, tgMessageId: messageId } });
        }
        catch (err) {
            logger_1.logger.warn({ err: String(err?.message ?? err), tg }, '[Support] не удалось отправить оператору');
        }
    }
}
/** Пуш покупателю. Ошибки не мешают основному действию. */
async function pushCustomer(chat, title, body) {
    try {
        let token = chat.pushToken?.trim() || '';
        if (!token && chat.phone) {
            const device = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone: chat.phone } });
            token = device?.token ?? '';
        }
        if (!token)
            return;
        await (0, pushBroadcast_service_1.sendBroadcast)({ title, body: body.slice(0, 180), tokens: [token], data: { type: 'support', chatId: chat.id } });
    }
    catch (err) {
        logger_1.logger.warn({ err: String(err?.message ?? err) }, '[Support] пуш покупателю не ушёл');
    }
}
/** Оператор написал, клиент после этого молчит дольше IDLE_MS. */
function idleExpired(chat, now = Date.now()) {
    if (chat.status !== 'active' || !chat.lastOperatorAt)
        return false;
    const op = new Date(chat.lastOperatorAt).getTime();
    if (chat.lastCustomerAt && new Date(chat.lastCustomerAt).getTime() >= op)
        return false;
    return now - op >= exports.IDLE_MS;
}
/** Закрывает чат, если клиент молчит минуту после оператора. true — закрыли сейчас. */
async function closeIfIdle(chatId, now = Date.now()) {
    const chat = await prisma_1.prisma.supportChat.findUnique({ where: { id: chatId } });
    if (!chat || !idleExpired(chat, now))
        return false;
    // Атомарно и только если за это время никто ничего не написал.
    const r = await prisma_1.prisma.supportChat.updateMany({
        where: { id: chat.id, status: 'active', lastOperatorAt: chat.lastOperatorAt },
        data: { status: 'closed', closedAt: new Date(now), closedBy: 'timeout' },
    });
    if (!r.count)
        return false;
    await prisma_1.prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'system', text: exports.IDLE_TEXT } });
    await pushCustomer(chat, 'Чат с оператором завершён', 'Вы не ответили в течение минуты. Баурсак на связи');
    const targets = chat.operatorTgChatId ? [chat.operatorTgChatId] : (0, telegramBot_1.allowedChatIds)();
    for (const tg of targets)
        await (0, telegramBot_1.sendMessage)(tg, `⚪️ Чат #${chat.number} закрыт автоматически: клиент не ответил 1 минуту.`).catch(() => undefined);
    logger_1.logger.info({ number: chat.number }, '[Support] чат закрыт по тишине клиента');
    return true;
}
/**
 * Через минуту после сообщения оператора проверяет, ответил ли клиент. Функция на Vercel живёт до 60 с,
 * поэтому ожидание идёт отдельным вызовом этого же сервера (/api/telegram-agent/support-idle).
 * Нет адреса сервера — чат всё равно закроется при следующем обращении (опрос приложения, сообщение).
 */
function scheduleIdleCheck(chatId) {
    if (!baseUrl)
        return;
    (0, functions_1.waitUntil)(fetch(`${baseUrl}/api/telegram-agent/support-idle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': (0, telegramBot_1.webhookSecret)() },
        body: JSON.stringify({ chatId }),
        signal: AbortSignal.timeout(10_000),
    }).then(() => undefined).catch((err) => logger_1.logger.warn({ err: String(err?.message ?? err) }, '[Support] не удалось запланировать проверку тишины')));
}
/**
 * Вызов /support-idle: ждёт, пока выйдет минута тишины (не дольше ~45 с за вызов, иначе передаёт
 * ожидание следующему вызову), и закрывает чат, если клиент так и не ответил.
 */
async function runIdleCheck(chatId) {
    const chat = await prisma_1.prisma.supportChat.findUnique({ where: { id: chatId } });
    if (!chat || chat.status !== 'active' || !chat.lastOperatorAt)
        return;
    const dueAt = new Date(chat.lastOperatorAt).getTime() + exports.IDLE_MS + 1_000;
    const wait = dueAt - Date.now();
    if (wait > 45_000) {
        await new Promise((r) => setTimeout(r, 40_000));
        scheduleIdleCheck(chatId);
        return;
    }
    if (wait > 0)
        await new Promise((r) => setTimeout(r, wait));
    await closeIfIdle(chatId);
}
async function startChat(input) {
    const phone = String(input.phone ?? '').replace(/\D/g, '').slice(0, 15) || null;
    const chat = await prisma_1.prisma.supportChat.create({
        data: {
            token: (0, crypto_1.randomBytes)(24).toString('hex'),
            phone,
            customerName: cleanText(input.customerName).slice(0, 80) || null,
            pushToken: cleanText(input.pushToken).slice(0, 400) || null,
            status: 'waiting',
        },
    });
    const question = cleanText(input.question);
    const greeting = 'Соединяю с оператором. Обычно отвечаем в течение нескольких минут — можно пока описать вопрос подробнее.';
    await prisma_1.prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'system', text: greeting } });
    // Последние реплики разговора с Баурсаком — оператору не придётся переспрашивать.
    const history = Array.isArray(input.history)
        ? input.history
            .filter((m) => m && typeof m.text === 'string' && m.text.trim())
            .map((m) => ({ fromUser: !!m.fromUser, text: String(m.text).replace(/\{\{[^}]*\}\}|\[\[[^\]]*\]\]/g, '').trim().slice(0, 300) }))
            .filter((m) => m.text)
            .slice(-8)
        : [];
    const parts = [`🟢 <b>Новый чат #${chat.number}</b> · ${(0, telegramBot_1.escapeHtml)(who(chat))}`];
    if (question)
        parts.push(`Вопрос: ${(0, telegramBot_1.escapeHtml)(question)}`);
    if (history.length)
        parts.push('', '<b>Разговор с Баурсаком:</b>', ...history.map((m) => `${m.fromUser ? '👤' : '🥯'} ${(0, telegramBot_1.escapeHtml)(m.text)}`));
    parts.push('', `Нажмите «Взять» и отвечайте реплаем на это сообщение (или пишите «#${chat.number} текст»).`);
    await notifyOperators(chat.id, parts.join('\n'), (0, telegramBot_1.allowedChatIds)(), takeButtons(chat.id));
    logger_1.logger.info({ number: chat.number }, '[Support] новый чат');
    return chat;
}
async function chatByToken(id, token) {
    if (!id || !token)
        return null;
    const chat = await prisma_1.prisma.supportChat.findUnique({ where: { id } });
    if (!chat || chat.token !== token)
        return null;
    return chat;
}
async function customerMessage(id, token, rawText) {
    const chat = await chatByToken(id, token);
    if (!chat)
        return { ok: false, code: 404, error: 'Чат не найден' };
    if (chat.status === 'closed' || (await closeIfIdle(chat.id)))
        return { ok: false, code: 409, error: 'Чат с оператором завершён' };
    const text = cleanText(rawText);
    if (!text)
        return { ok: false, code: 400, error: 'Пустое сообщение' };
    const message = await prisma_1.prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'customer', text } });
    await prisma_1.prisma.supportChat.update({ where: { id: chat.id }, data: { lastCustomerAt: new Date() } });
    const targets = chat.status === 'active' && chat.operatorTgChatId ? [chat.operatorTgChatId] : (0, telegramBot_1.allowedChatIds)();
    await notifyOperators(chat.id, `💬 <b>#${chat.number}</b> · ${(0, telegramBot_1.escapeHtml)(who(chat))}:\n${(0, telegramBot_1.escapeHtml)(text)}`, targets, chat.status === 'waiting' ? takeButtons(chat.id) : undefined);
    return { ok: true, message };
}
async function chatState(id, token, after = 0) {
    let chat = await chatByToken(id, token);
    if (!chat)
        return null;
    if (await closeIfIdle(chat.id))
        chat = (await chatByToken(id, token)) ?? chat;
    const messages = await prisma_1.prisma.supportMessage.findMany({
        where: { chatId: chat.id, id: { gt: Math.max(0, Math.floor(after) || 0) } },
        orderBy: { id: 'asc' },
        take: 100,
    });
    return {
        id: chat.id,
        number: chat.number,
        status: chat.status,
        operatorName: chat.operatorName,
        messages: messages.map((m) => ({ id: m.id, sender: m.sender, text: m.text, operatorName: m.operatorName, createdAt: m.createdAt })),
    };
}
async function closeByCustomer(id, token) {
    const chat = await chatByToken(id, token);
    if (!chat)
        return false;
    if (chat.status === 'closed')
        return true;
    await prisma_1.prisma.supportChat.update({ where: { id: chat.id }, data: { status: 'closed', closedAt: new Date(), closedBy: 'customer' } });
    await prisma_1.prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'system', text: 'Вы завершили чат с оператором. Дальше снова отвечает Баурсак.' } });
    const targets = chat.operatorTgChatId ? [chat.operatorTgChatId] : (0, telegramBot_1.allowedChatIds)();
    for (const tg of targets)
        await (0, telegramBot_1.sendMessage)(tg, `⚪️ Покупатель завершил чат #${chat.number}.`).catch(() => undefined);
    return true;
}
/** Имя оператора для клиента: заданное командой «/имя», иначе имя из Telegram (без почты). */
async function operatorNameOf(from) {
    if (from?.id) {
        const saved = await prisma_1.prisma.supportOperator.findUnique({ where: { tgUserId: String(from.id) } }).catch(() => null);
        if (saved?.name)
            return saved.name;
    }
    const raw = (from?.first_name || from?.username || '').trim();
    const clean = raw.includes('@') ? '' : raw; // в Telegram вместо имени бывает почта — клиенту её не показываем
    return (clean || 'Оператор').slice(0, 40);
}
const HELP = [
    'Это бот поддержки My Market.',
    '• Новый чат приходит с кнопками «Взять» / «Завершить».',
    '• Взяли один чат — просто пишите сообщение, оно уйдёт клиенту.',
    '• Несколько чатов — отвечайте реплаем на сообщение нужного чата или «#номер текст».',
    '• «/имя Аслан» — как вас увидят клиенты.',
].join('\n');
async function take(chatId, tgChatId, operatorName, silentIfMine = false) {
    const chat = await prisma_1.prisma.supportChat.findUnique({ where: { id: chatId } });
    if (!chat)
        return null;
    if (chat.status === 'closed') {
        await (0, telegramBot_1.sendMessage)(tgChatId, `Чат #${chat.number} уже завершён.`).catch(() => undefined);
        return null;
    }
    if (chat.status === 'active' && chat.operatorTgChatId && chat.operatorTgChatId !== tgChatId) {
        await (0, telegramBot_1.sendMessage)(tgChatId, `Чат #${chat.number} уже взял(а) ${(0, telegramBot_1.escapeHtml)(chat.operatorName ?? 'другой оператор')}.`).catch(() => undefined);
        return null;
    }
    if (chat.status === 'active') {
        if (!silentIfMine)
            await (0, telegramBot_1.sendMessage)(tgChatId, `Чат #${chat.number} уже ваш.`).catch(() => undefined);
        return chat;
    }
    // Атомарно: взять может только один оператор.
    const r = await prisma_1.prisma.supportChat.updateMany({
        where: { id: chat.id, status: 'waiting' },
        data: { status: 'active', operatorName, operatorTgChatId: tgChatId },
    });
    if (!r.count)
        return take(chatId, tgChatId, operatorName, silentIfMine);
    await prisma_1.prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'system', text: `${operatorName} подключился(ась) к чату`, operatorName } });
    await pushCustomer(chat, 'Оператор на связи', `${operatorName} подключился(ась) к чату`);
    await notifyOperators(chat.id, `✅ Вы взяли чат <b>#${chat.number}</b> · ${(0, telegramBot_1.escapeHtml)(who(chat))}.\nОтвечайте реплаем на сообщения этого чата или «#${chat.number} текст».`, [tgChatId], closeButtons(chat.id));
    // Остальным операторам — что чат занят.
    for (const tg of (0, telegramBot_1.allowedChatIds)()) {
        if (tg !== tgChatId)
            await (0, telegramBot_1.sendMessage)(tg, `Чат #${chat.number} взял(а) ${(0, telegramBot_1.escapeHtml)(operatorName)}.`).catch(() => undefined);
    }
    return { ...chat, status: 'active', operatorName, operatorTgChatId: tgChatId };
}
async function closeByOperator(chatId, tgChatId, operatorName) {
    const chat = await prisma_1.prisma.supportChat.findUnique({ where: { id: chatId } });
    if (!chat)
        return;
    if (chat.status === 'closed') {
        await (0, telegramBot_1.sendMessage)(tgChatId, `Чат #${chat.number} уже завершён.`).catch(() => undefined);
        return;
    }
    await prisma_1.prisma.supportChat.update({ where: { id: chat.id }, data: { status: 'closed', closedAt: new Date(), closedBy: 'operator' } });
    await prisma_1.prisma.supportMessage.create({
        data: { chatId: chat.id, sender: 'system', text: 'Оператор завершил чат. Если остались вопросы — пишите, дальше снова отвечает Баурсак 🙂', operatorName },
    });
    await pushCustomer(chat, 'Чат с оператором завершён', 'Если остались вопросы — Баурсак на связи');
    await (0, telegramBot_1.sendMessage)(tgChatId, `⚪️ Чат #${chat.number} завершён.`).catch(() => undefined);
}
async function operatorReply(chatId, tgChatId, operatorName, rawText) {
    const text = cleanText(rawText);
    if (!text)
        return;
    if (await closeIfIdle(chatId))
        return; // клиент уже минуту молчал — чат закрыт, оператору ушло уведомление
    const chat = await take(chatId, tgChatId, operatorName, true);
    if (!chat)
        return;
    await prisma_1.prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'operator', text, operatorName } });
    await prisma_1.prisma.supportChat.update({ where: { id: chat.id }, data: { lastOperatorAt: new Date() } });
    scheduleIdleCheck(chat.id);
    await pushCustomer(chat, `${operatorName} (оператор)`, text);
    await (0, telegramBot_1.sendMessage)(tgChatId, `✓ Отправлено в чат #${chat.number}`).catch(() => undefined);
}
/**
 * Обрабатывает апдейт Telegram, если он относится к чатам поддержки.
 * true — апдейт наш (дальше его никто не обрабатывает), false — пусть обработает агент товаров.
 */
async function handleSupportUpdate(update) {
    const cb = update.callback_query;
    if (cb?.data?.startsWith('sup:')) {
        const tgChat = cb.message?.chat.id;
        await (0, telegramBot_1.answerCallback)(cb.id);
        if (!tgChat || !(0, telegramBot_1.isAllowedChat)(tgChat))
            return true;
        const [, action, id] = cb.data.split(':');
        const name = await operatorNameOf(cb.from);
        if (action === 'take' && id)
            await take(id, String(tgChat), name);
        if (action === 'close' && id)
            await closeByOperator(id, String(tgChat), name);
        return true;
    }
    const m = update.message;
    if (!m || !m.text || !(0, telegramBot_1.isAllowedChat)(m.chat.id))
        return false;
    const tgChat = String(m.chat.id);
    const text = m.text.trim();
    // «/имя Аслан» — имя, которое увидят клиенты.
    const setName = text.match(/^\/(?:имя|name)(?:@\w+)?\s+(.{1,40})$/i);
    if (setName && m.from?.id) {
        const name = setName[1].trim();
        await prisma_1.prisma.supportOperator.upsert({ where: { tgUserId: String(m.from.id) }, create: { tgUserId: String(m.from.id), name }, update: { name } });
        await (0, telegramBot_1.sendMessage)(tgChat, `Готово: клиенты увидят «${(0, telegramBot_1.escapeHtml)(name)}».`).catch(() => undefined);
        return true;
    }
    if (/^\/(start|help|помощь)\b/i.test(text)) {
        await (0, telegramBot_1.sendMessage)(tgChat, HELP).catch(() => undefined);
        return true;
    }
    const name = await operatorNameOf(m.from);
    // «#125 текст» — ответ в чат по номеру.
    const byNumber = m.text.match(/^#(\d{1,9})\s+([\s\S]+)$/);
    if (byNumber) {
        const chat = await prisma_1.prisma.supportChat.findUnique({ where: { number: Number(byNumber[1]) } });
        if (!chat) {
            await (0, telegramBot_1.sendMessage)(tgChat, `Чата #${byNumber[1]} нет.`).catch(() => undefined);
            return true;
        }
        await operatorReply(chat.id, tgChat, name, byNumber[2]);
        return true;
    }
    // Реплай на сообщение бота, которое относится к чату поддержки.
    const replyTo = m.reply_to_message?.message_id;
    if (replyTo) {
        const ref = await prisma_1.prisma.supportTgRef.findUnique({ where: { tgChatId_tgMessageId: { tgChatId: tgChat, tgMessageId: replyTo } } });
        if (ref) {
            await operatorReply(ref.supportChatId, tgChat, name, m.text);
            return true;
        }
    }
    // Просто сообщение: если у этого оператора один открытый чат — отправляем в него.
    const mine = await prisma_1.prisma.supportChat.findMany({
        where: { status: 'active', operatorTgChatId: tgChat },
        orderBy: { updatedAt: 'desc' },
        take: 5,
    });
    if (mine.length === 1) {
        await operatorReply(mine[0].id, tgChat, name, m.text);
        return true;
    }
    if (mine.length > 1) {
        await (0, telegramBot_1.sendMessage)(tgChat, `У вас открыто ${mine.length} чата (${mine.map((c) => '#' + c.number).join(', ')}). Ответьте реплаем на сообщение нужного чата или напишите «#номер текст».`).catch(() => undefined);
        return true;
    }
    return false;
}
//# sourceMappingURL=support.service.js.map