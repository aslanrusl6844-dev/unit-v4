"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceFeedRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../db/prisma");
const env_1 = require("../config/env");
const kaspi_client_1 = require("../integrations/kaspi.client");
const logger_1 = require("../utils/logger");
exports.priceFeedRouter = (0, express_1.Router)();
function escapeXml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * XML-прайс-лист в формате, который Kaspi понимает для автоматической
 * загрузки цен (см. Kaspi Гид: "Как настроить автоматическую загрузку
 * прайс-листа"). Эту ссылку нужно один раз указать в личном кабинете
 * Kaspi: Магазин на Kaspi.kz → Товары → Загрузить прайс-лист →
 * автоматическая загрузка. Дальше Kaspi сам периодически её проверяет.
 *
 * Защищено секретным токеном в query (?token=...), чтобы ссылку не мог
 * дёргать кто попало — задайте PRICE_FEED_SECRET в .env.
 */
exports.priceFeedRouter.get('/price-feed.xml', async (req, res) => {
    if (env_1.env.priceFeedSecret && req.query.token !== env_1.env.priceFeedSecret) {
        return res.status(403).send('Forbidden');
    }
    const products = await prisma_1.prisma.product.findMany({
        where: { kaspiSku: { not: null }, currentKaspiPrice: { not: null }, active: true },
    });
    const creds = await (0, kaspi_client_1.getKaspiCredentials)();
    const merchantUid = creds?.merchantUid || 'MyShop';
    const offers = products
        .map((p) => `  <offer sku="${escapeXml(p.kaspiSku)}">
    <price>${Math.round(p.currentKaspiPrice)}</price>
  </offer>`)
        .join('\n');
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<kaspi_catalog date="${new Date().toISOString()}" xmlns="kaspiShopping" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="kaspiShopping http://kaspi.kz/kaspishopping.xsd">
  <company>${escapeXml(merchantUid)}</company>
  <merchantid>${escapeXml(merchantUid)}</merchantid>
  <offers>
${offers}
  </offers>
</kaspi_catalog>`;
    logger_1.logger.debug(`[PriceFeed] Отдан прайс-лист: ${products.length} товаров`);
    res.type('application/xml').send(xml);
});
//# sourceMappingURL=priceFeed.routes.js.map