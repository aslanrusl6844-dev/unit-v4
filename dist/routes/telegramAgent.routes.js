"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramAgentRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const functions_1 = require("@vercel/functions");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const telegramBot_1 = require("../lib/telegramBot");
const productDraft_service_1 = require("../services/productDraft.service");
const support_service_1 = require("../services/support.service");
exports.telegramAgentRouter = (0, express_1.Router)();
function secretOk(given) {
    if (!env_1.env.telegramBotToken || !given)
        return false;
    const a = Buffer.from(given);
    const b = Buffer.from((0, telegramBot_1.webhookSecret)());
    return a.length === b.length && (0, crypto_1.timingSafeEqual)(a, b);
}
/** Публичный путь (см. adminAuth), защита — секретный заголовок Telegram. */
exports.telegramAgentRouter.post('/webhook', (req, res) => {
    if (!secretOk(req.header('x-telegram-bot-api-secret-token')))
        return res.status(401).json({ ok: false });
    const host = req.header('x-forwarded-host') || req.header('host');
    if (host) {
        (0, productDraft_service_1.setSelfBaseUrl)(`https://${host}`);
        (0, support_service_1.setSupportBaseUrl)(`https://${host}`);
    }
    res.json({ ok: true }); // Telegram ждёт быстрый ответ; работа идёт дальше в фоне
    (0, functions_1.waitUntil)((0, productDraft_service_1.handleUpdate)(req.body).catch((err) => logger_1.logger.error({ err: String(err?.message ?? err) }, '[TelegramAgent] webhook')));
});
/** Админский (Basic) — один раз регистрирует вебхук бота на этот сервер. */
exports.telegramAgentRouter.get('/setup', async (req, res) => {
    if (!env_1.env.telegramBotToken)
        return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN не настроен' });
    const host = req.header('x-forwarded-host') || req.header('host');
    try {
        await (0, telegramBot_1.setWebhook)(`https://${host}/api/telegram-agent/webhook`);
        res.json({ ok: true, webhook: `https://${host}/api/telegram-agent/webhook` });
    }
    catch (err) {
        res.status(502).json({ error: 'Не удалось зарегистрировать вебхук', details: String(err?.message ?? err) });
    }
});
/** Служебный: чат с оператором — закрыть, если клиент минуту не отвечает (зовёт сам сервер, защита — тот же секрет). */
exports.telegramAgentRouter.post('/support-idle', (req, res) => {
    if (!secretOk(req.header('x-telegram-bot-api-secret-token')))
        return res.status(401).json({ ok: false });
    const chatId = req.body?.chatId;
    if (typeof chatId !== 'string' || !chatId)
        return res.status(400).json({ ok: false });
    const host = req.header('x-forwarded-host') || req.header('host');
    if (host)
        (0, support_service_1.setSupportBaseUrl)(`https://${host}`);
    res.json({ ok: true });
    (0, functions_1.waitUntil)((0, support_service_1.runIdleCheck)(chatId).catch((err) => logger_1.logger.error({ err: String(err?.message ?? err) }, '[Support] idle')));
});
/** Служебный: рисует одну сцену (зовёт сам сервер, защита — тот же секрет). Отвечает сразу, работа в фоне. */
exports.telegramAgentRouter.post('/scene', (req, res) => {
    if (!secretOk(req.header('x-telegram-bot-api-secret-token')))
        return res.status(401).json({ ok: false });
    const { draftId, index } = req.body ?? {};
    if (typeof draftId !== 'string' || !Number.isInteger(index))
        return res.status(400).json({ ok: false });
    res.json({ ok: true });
    (0, functions_1.waitUntil)((0, productDraft_service_1.handleSceneJob)(draftId, index).catch((err) => logger_1.logger.error({ err: String(err?.message ?? err) }, '[TelegramAgent] scene')));
});
//# sourceMappingURL=telegramAgent.routes.js.map