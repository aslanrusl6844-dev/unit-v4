"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supportRouter = void 0;
const express_1 = require("express");
const logger_1 = require("../utils/logger");
const support_service_1 = require("../services/support.service");
/**
 * Чат с оператором из чата Баурсака. Смонтирован внутри assistantRouter (/api/shop/assistant/support),
 * x-app-key проверяется там. Каждый чат защищён своим токеном: его выдаёт /start, приложение
 * передаёт его в заголовке x-support-token.
 */
exports.supportRouter = (0, express_1.Router)();
// Лимит на IP: 30 запросов в минуту на отправку (опрос новых сообщений не ограничиваем).
const hits = new Map();
function limited(ip, max = 30) {
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > max;
}
const tokenOf = (req) => String(req.header('x-support-token') ?? '');
exports.supportRouter.post('/start', async (req, res) => {
    if (limited(`start:${req.ip}`, 20))
        return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
    try {
        const b = req.body ?? {};
        const chat = await (0, support_service_1.startChat)({ phone: b.phone, customerName: b.customerName, pushToken: b.pushToken, question: b.question, history: b.history });
        const state = await (0, support_service_1.chatState)(chat.id, chat.token, 0);
        res.json({ ...state, token: chat.token });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Support] /start упал');
        res.status(500).json({ error: 'Не удалось соединить с оператором, попробуйте ещё раз' });
    }
});
exports.supportRouter.get('/:id', async (req, res) => {
    try {
        const state = await (0, support_service_1.chatState)(req.params.id, tokenOf(req), Number(req.query.after ?? 0));
        if (!state)
            return res.status(404).json({ error: 'Чат не найден' });
        res.json(state);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Support] GET упал');
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});
exports.supportRouter.post('/:id/messages', async (req, res) => {
    if (limited(`msg:${req.ip}`))
        return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
    try {
        const r = await (0, support_service_1.customerMessage)(req.params.id, tokenOf(req), req.body?.text);
        if (!r.ok)
            return res.status(r.code).json({ error: r.error });
        res.json({ message: { id: r.message.id, sender: r.message.sender, text: r.message.text, createdAt: r.message.createdAt } });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Support] сообщение упало');
        res.status(500).json({ error: 'Не удалось отправить, попробуйте ещё раз' });
    }
});
exports.supportRouter.post('/:id/close', async (req, res) => {
    try {
        const ok = await (0, support_service_1.closeByCustomer)(req.params.id, tokenOf(req));
        if (!ok)
            return res.status(404).json({ error: 'Чат не найден' });
        res.json({ ok: true });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Support] close упал');
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});
//# sourceMappingURL=support.routes.js.map