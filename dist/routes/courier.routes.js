"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.courierRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
exports.courierRouter = (0, express_1.Router)();
// Тот же ключ приложения — курьер тоже работает через приложение/его API.
exports.courierRouter.use((req, res, next) => {
    if (!env_1.env.shopAppKey) {
        return res.status(503).json({ error: 'SHOP_APP_KEY не настроен на сервере' });
    }
    const key = req.header('x-app-key');
    if (key !== env_1.env.shopAppKey) {
        return res.status(401).json({ error: 'Неверный или отсутствующий заголовок x-app-key' });
    }
    next();
});
const deliverSchema = zod_1.z.object({
    number: zod_1.z.string().min(1), // номер заказа
    pickupCode: zod_1.z.string().min(1), // код выдачи, который называет покупатель
});
/**
 * Подтверждение выдачи — номер заказа + код выдачи (4 цифры), который
 * покупатель называет курьеру/на ПВЗ. Остаток товара уже был списан на
 * этапе оплаты (paid) — здесь только меняется статус на delivered.
 */
exports.courierRouter.post('/deliver', async (req, res) => {
    const parsed = deliverSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Укажите номер заказа и код выдачи' });
    try {
        const order = await prisma_1.prisma.shopOrder.findUnique({ where: { number: parsed.data.number } });
        if (!order)
            return res.status(404).json({ error: 'Заказ с таким номером не найден' });
        if (order.pickupCode !== parsed.data.pickupCode) {
            return res.status(400).json({ error: 'Код выдачи не совпадает' });
        }
        if (order.status === 'delivered') {
            return res.status(409).json({ error: 'Заказ уже отмечен как выданный' });
        }
        if (order.status !== 'paid' && order.status !== 'assembled') {
            return res.status(409).json({ error: `Заказ в статусе "${order.status}" — сначала должен быть оплачен` });
        }
        await prisma_1.prisma.shopOrder.update({ where: { id: order.id }, data: { status: 'delivered', deliveredAt: new Date() } });
        // Синхронизируем и связанный Order (для отчётности) в тот же статус.
        await prisma_1.prisma.order.updateMany({ where: { marketplace: 'APP', externalId: order.number }, data: { status: 'delivered' } });
        res.json({ ok: true, status: 'delivered' });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Courier API] Ошибка подтверждения выдачи');
        res.status(500).json({ error: 'Не удалось подтвердить выдачу', details: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=courier.routes.js.map