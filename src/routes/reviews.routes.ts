import { Router } from 'express';
import { prisma } from '@/db/prisma';
import { fetchProductPageInfo } from '@/integrations/kaspi.scraper';
import { logger } from '@/utils/logger';

export const reviewsRouter = Router();

reviewsRouter.get('/', async (_req, res) => {
  const products = await prisma.product.findMany({
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
reviewsRouter.post('/:productId/refresh', async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
  if (!product?.kaspiProductUrl) return res.status(404).json({ error: 'У товара не указана ссылка на Kaspi' });

  const info = await fetchProductPageInfo(product.kaspiProductUrl);
  const updated = await prisma.product.update({
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
reviewsRouter.post('/refresh-all', async (_req, res) => {
  const products = await prisma.product.findMany({ where: { kaspiProductUrl: { not: null } } });
  let updated = 0;

  for (const product of products) {
    const info = await fetchProductPageInfo(product.kaspiProductUrl!);
    if (info.ratingValue == null && info.reviewCount == null) continue;
    await prisma.product.update({
      where: { id: product.id },
      data: {
        kaspiRating: info.ratingValue ?? product.kaspiRating,
        kaspiReviewCount: info.reviewCount ?? product.kaspiReviewCount,
        reviewsUpdatedAt: new Date(),
      },
    });
    updated += 1;
  }

  logger.info(`[Отзывы] Обновлено товаров: ${updated} из ${products.length}`);
  res.json({ ok: true, total: products.length, updated });
});
