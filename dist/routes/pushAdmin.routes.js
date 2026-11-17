"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushAdminRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const shop_routes_1 = require("./shop.routes");
const pushBroadcast_service_1 = require("../services/pushBroadcast.service");
/**
 * Админка → «Рассылка»: пуш всем покупателям с токеном (ShopCustomerPushToken)
 * или тестовый пуш на один номер. Вход — Basic admin (глобальный
 * adminAuthMiddleware на /api/*). Картинка — URL из существующей загрузки в Blob.
 */
exports.pushAdminRouter = (0, express_1.Router)();
const httpsUrl = zod_1.z.string().trim().max(2000).refine((u) => /^https:\/\/\S+$/i.test(u), 'Картинка должна быть ссылкой https://');
const sendSchema = zod_1.z.object({
    title: zod_1.z.string().trim().min(1, 'Укажи заголовок').max(100),
    body: zod_1.z.string().trim().min(1, 'Укажи текст').max(500),
    imageUrl: httpsUrl.optional().nullable().or(zod_1.z.literal('')),
    // 'test' — один номер (testPhone обязателен); 'all' — всем, только явно.
    audience: zod_1.z.enum(['test', 'all']),
    testPhone: zod_1.z.string().optional().nullable(),
    // Показать на телефоне весь текст (data-пуш: приложение рисует баннер само). Без флага — как раньше.
    fullText: zod_1.z.boolean().optional(),
});
/** Сколько получателей у рассылки «всем». */
exports.pushAdminRouter.get('/audience', async (_req, res) => {
    try {
        const rows = await prisma_1.prisma.shopCustomerPushToken.findMany({ select: { token: true } });
        const expo = rows.filter((r) => (0, pushBroadcast_service_1.isExpoToken)(r.token)).length;
        res.json({ total: rows.length, expo, fcm: rows.length - expo, firebaseConfigured: !!(process.env.FIREBASE_KEY ?? '').trim() });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[PushAdmin] GET /audience упал');
        res.status(500).json({ error: 'Не удалось получить аудиторию', details: String(err?.message ?? err) });
    }
});
exports.pushAdminRouter.post('/send', async (req, res) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    const { title, body, audience } = parsed.data;
    const imageUrl = parsed.data.imageUrl ? parsed.data.imageUrl : null; // '' / null → без картинки
    try {
        let tokens = [];
        if (audience === 'test') {
            const phone = (0, shop_routes_1.normalizePhone)(String(parsed.data.testPhone ?? ''));
            if (!phone)
                return res.status(400).json({ error: 'Для теста укажи корректный номер телефона' });
            const rec = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone } });
            if (!rec?.token)
                return res.status(404).json({ error: 'У этого номера нет зарегистрированного токена — пуш некуда отправить' });
            tokens = [rec.token];
        }
        else {
            const rows = await prisma_1.prisma.shopCustomerPushToken.findMany({ select: { token: true } });
            tokens = rows.map((r) => r.token);
        }
        if (!tokens.length)
            return res.status(404).json({ error: 'Нет получателей с зарегистрированным токеном' });
        const imageWarning = imageUrl ? await (0, pushBroadcast_service_1.checkPushImage)(imageUrl) : null;
        const result = await (0, pushBroadcast_service_1.sendBroadcast)({ title, body, imageUrl, tokens, fullText: parsed.data.fullText === true });
        logger_1.logger.info({ audience, ...result }, '[PushAdmin] Рассылка отправлена');
        res.json({ ok: true, audience, ...result, ...(imageWarning ? { imageWarning } : {}) });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[PushAdmin] POST /send упал');
        res.status(500).json({ error: 'Не удалось отправить рассылку', details: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=pushAdmin.routes.js.map