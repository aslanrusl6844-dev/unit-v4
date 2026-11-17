"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marginCalculatorRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const kaspi_scraper_1 = require("../integrations/kaspi.scraper");
const kaspi_categories_1 = require("../integrations/kaspi.categories");
const kaspi_delivery_1 = require("../integrations/kaspi.delivery");
exports.marginCalculatorRouter = (0, express_1.Router)();
// Шаг 1: вставили ссылку — подтягиваем название и текущую цену со страницы.
exports.marginCalculatorRouter.post('/scrape', async (req, res) => {
    const schema = zod_1.z.object({ url: zod_1.z.string().url() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    const info = await (0, kaspi_scraper_1.fetchProductPageInfo)(parsed.data.url);
    if (!info.price) {
        return res.status(422).json({ error: 'Не удалось прочитать цену со страницы. Заполните поля вручную.' });
    }
    res.json(info);
});
// Список категорий для выпадающего списка на этом же экране.
exports.marginCalculatorRouter.get('/categories', (_req, res) => {
    res.json(Object.entries(kaspi_categories_1.KASPI_TOP_CATEGORY_RATE).map(([name, rate]) => ({ name, rate })));
});
// Шаг 2: считаем маржу по введённым данным.
// Себестоимость теперь СОБИРАЕТСЯ из трёх частей (как у конкурента
// Northline) — это удобнее для тех, кто возит товар с 1688.com через карго:
//   costPrice = price1688 + cargoRatePerKg * weightKg + packagingCost
// Если кто-то уже знает готовую себестоимость одним числом — можно
// передать её напрямую в price1688, а cargoRatePerKg оставить 0.
const calcSchema = zod_1.z.object({
    price: zod_1.z.number().positive(),
    price1688: zod_1.z.number().nonnegative().default(0),
    cargoRatePerKg: zod_1.z.number().nonnegative().default(0),
    packagingCost: zod_1.z.number().nonnegative().default(0),
    weightKg: zod_1.z.number().positive().default(0.5),
    kaspiTopCategory: zod_1.z.string(),
    kaspiLeafCategory: zod_1.z.string().optional(),
    deliveryZone: zod_1.z.enum(['city', 'kazakhstan', 'express']).default('kazakhstan'),
    kaspiDelivery: zod_1.z.boolean().default(true),
    targetMarginPct: zod_1.z.number().min(0).max(95).default(20),
});
exports.marginCalculatorRouter.post('/calculate', (req, res) => {
    const parsed = calcSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;
    const commissionRate = kaspi_categories_1.KASPI_TOP_CATEGORY_RATE[d.kaspiTopCategory] ?? null;
    const commission = (0, kaspi_categories_1.calcKaspiCommissionAmount)(d.price, {
        topCategory: d.kaspiTopCategory,
        leafCategory: d.kaspiLeafCategory,
    });
    const logistics = d.kaspiDelivery
        ? (0, kaspi_delivery_1.calculateKaspiDeliveryCost)(d.price, d.weightKg, d.deliveryZone)
        : 0;
    const cargoCost = d.cargoRatePerKg * d.weightKg;
    const costPrice = d.price1688 + cargoCost + d.packagingCost;
    const netProfit = Math.round((d.price - commission - logistics - costPrice) * 100) / 100;
    const marginPct = d.price > 0 ? Math.round((netProfit / d.price) * 1000) / 10 : 0;
    const roiPct = costPrice > 0 ? Math.round((netProfit / costPrice) * 1000) / 10 : 0;
    const goalReached = marginPct >= d.targetMarginPct;
    res.json({
        price: d.price,
        commission,
        commissionRate,
        logistics,
        price1688: d.price1688,
        cargoCost: Math.round(cargoCost * 100) / 100,
        packagingCost: d.packagingCost,
        costPrice: Math.round(costPrice * 100) / 100,
        netProfit,
        marginPct,
        roiPct,
        targetMarginPct: d.targetMarginPct,
        goalReached,
        // Вердикт как у конкурента: "Брать" — не просто прибыльно, а достигает
        // ЦЕЛЕВОЙ маржи. Товар с маржой 3% формально "прибыльный", но брать его
        // в оборот обычно не имеет смысла.
        verdict: netProfit > 0 && goalReached ? 'BUY' : 'SKIP',
        isProfitable: netProfit > 0,
    });
});
/**
 * Для слайдера "что если уронить цену под демпинг" — тот же расчёт, но по
 * произвольной цене. Используется тот же эндпоинт /calculate с другим
 * значением price, чтобы формула точно не разъезжалась между "основным"
 * расчётом и "что если" — везде одна и та же функция на сервере.
 */
//# sourceMappingURL=marginCalculator.routes.js.map