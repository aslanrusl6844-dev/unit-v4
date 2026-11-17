"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewsRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../db/prisma");
const kaspi_scraper_1 = require("../integrations/kaspi.scraper");
const logger_1 = require("../utils/logger");
exports.reviewsRouter = (0, express_1.Router)();
exports.reviewsRouter.get('/', async (_req, res) => {
    const products = await prisma_1.prisma.product.findMany({
        where: { kaspiProductUrl: { not: null } },
        select: {
            id: true,
            sku: true,
            name: true,
            kaspiRating: true,
            kaspiReviewCount: true,
            reviewsUpdatedAt: true,
        },
        orderBy: { kaspiReviewCount: 'desc' },
    });
    res.json(products);
});
// Обновить рейтинг/число отзывов у одного товара.
exports.reviewsRouter.post('/:productId/refresh', async (req, res) => {
    const product = await prisma_1.prisma.product.findUnique({ where: { id: req.params.productId } });
    if (!product?.kaspiProductUrl)
        return res.status(404).json({ error: 'У товара не указана ссылка на Kaspi' });
    const info = await (0, kaspi_scraper_1.fetchProductPageInfo)(product.kaspiProductUrl);
    const updated = await prisma_1.prisma.product.update({
        where: { id: product.id },
        data: {
            kaspiRating: info.ratingValue ?? product.kaspiRating,
            kaspiReviewCount: info.reviewCount ?? product.kaspiReviewCount,
            reviewsUpdatedAt: new Date(),
        },
    });
    res.json(updated);
});
// Обновить рейтинг/отзывы у всех товаров разом.
exports.reviewsRouter.post('/refresh-all', async (_req, res) => {
    const products = await prisma_1.prisma.product.findMany({ where: { kaspiProductUrl: { not: null } } });
    let updated = 0;
    for (const product of products) {
        const info = await (0, kaspi_scraper_1.fetchProductPageInfo)(product.kaspiProductUrl);
        if (info.ratingValue == null && info.reviewCount == null)
            continue;
        await prisma_1.prisma.product.update({
            where: { id: product.id },
            data: {
                kaspiRating: info.ratingValue ?? product.kaspiRating,
                kaspiReviewCount: info.reviewCount ?? product.kaspiReviewCount,
                reviewsUpdatedAt: new Date(),
            },
        });
        updated += 1;
    }
    logger_1.logger.info(`[Отзывы] Обновлено товаров: ${updated} из ${products.length}`);
    res.json({ ok: true, total: products.length, updated });
});
//# sourceMappingURL=reviews.routes.js.map