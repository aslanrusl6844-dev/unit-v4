import { Router } from 'express';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const priceFeedRouter = Router();

function escapeXml(value: string): string {
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
priceFeedRouter.get('/price-feed.xml', async (req, res) => {
  if (env.priceFeedSecret && req.query.token !== env.priceFeedSecret) {
    return res.status(403).send('Forbidden');
  }

  const products = await prisma.product.findMany({
    where: { kaspiSku: { not: null }, currentKaspiPrice: { not: null }, active: true },
  });

  const offers = products
    .map(
      (p) => `  <offer sku="${escapeXml(p.kaspiSku!)}">
    <price>${Math.round(p.currentKaspiPrice!)}</price>
  </offer>`,
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<kaspi_catalog date="${new Date().toISOString()}" xmlns="kaspiShopping" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="kaspiShopping http://kaspi.kz/kaspishopping.xsd">
  <company>${escapeXml(env.kaspi.merchantUid || 'MyShop')}</company>
  <merchantid>${escapeXml(env.kaspi.merchantUid || '')}</merchantid>
  <offers>
${offers}
  </offers>
</kaspi_catalog>`;

  logger.debug(`[PriceFeed] Отдан прайс-лист: ${products.length} товаров`);
  res.type('application/xml').send(xml);
});
