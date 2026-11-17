"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.repricerRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const repricer_service_1 = require("../services/repricer.service");
exports.repricerRouter = (0, express_1.Router)();
const settingsSchema = zod_1.z.object({
    kaspiProductUrl: zod_1.z.string().url().optional().nullable(),
    autoRepriceEnabled: zod_1.z.boolean().optional(),
    minPrice: zod_1.z.number().positive().optional().nullable(),
    maxPrice: zod_1.z.number().positive().optional().nullable(),
    repriceStep: zod_1.z.number().nonnegative().optional(),
    repriceStrategy: zod_1.z.enum(['FIRST_PLACE', 'MATCH_FIRST', 'STICK_TO_FIRST', 'SECOND_PLACE']).optional(),
});
// Настроить автобот для конкретного товара.
exports.repricerRouter.put('/:productId/settings', async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    try {
        const product = await prisma_1.prisma.product.update({
            where: { id: req.params.productId },
            data: parsed.data,
        });
        res.json(product);
    }
    catch {
        res.status(404).json({ error: 'Товар не найден' });
    }
});
// История изменений цены по товару.
exports.repricerRouter.get('/:productId/history', async (req, res) => {
    const history = await prisma_1.prisma.priceHistory.findMany({
        where: { productId: req.params.productId },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
    res.json(history);
});
// Запустить пересчёт цен вручную (не дожидаясь расписания).
exports.repricerRouter.post('/run', async (_req, res) => {
    try {
        const results = await (0, repricer_service_1.runRepricingCycle)();
        res.json({ ok: true, results });
    }
    catch (err) {
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=repricer.routes.js.map