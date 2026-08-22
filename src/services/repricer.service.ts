import { prisma } from '../db/prisma';
import { fetchCompetitorPrices } from '../integrations/kaspi.scraper';
import { logger } from '../utils/logger';

export interface RepriceResult {
  productId: string;
  sku: string;
  oldPrice: number | null;
  newPrice: number;
  lowestCompetitorPrice: number | null;
  hitFloor: boolean;
  changed: boolean;
}

/**
 * Считает новую цену для одного товара:
 * - находит самую низкую цену конкурента на странице;
 * - вычитает repriceStep, чтобы стать дешевле;
 * - НИКОГДА не опускается ниже minPrice (защита от продажи в убыток).
 */
export async function repriceProduct(product: {
  id: string;
  sku: string;
  kaspiProductUrl: string | null;
  minPrice: number | null;
  repriceStep: number;
  currentKaspiPrice: number | null;
}): Promise<RepriceResult | null> {
  if (!product.kaspiProductUrl) {
    logger.warn(`[Repricer] У товара ${product.sku} не указана ссылка kaspiProductUrl — пропуск`);
    return null;
  }
  if (product.minPrice == null) {
    logger.warn(`[Repricer] У товара ${product.sku} не задана минимальная цена (minPrice) — пропуск, чтобы не уйти в убыток`);
    return null;
  }

  const competitors = await fetchCompetitorPrices(product.kaspiProductUrl);
  // Исключаем нашу же текущую цену из списка "конкурентов", если она туда попала.
  const otherPrices = competitors.filter((c) => c.price !== product.currentKaspiPrice);
  const lowestCompetitorPrice = otherPrices.length > 0 ? otherPrices[0].price : null;

  let newPrice: number;
  let hitFloor = false;

  if (lowestCompetitorPrice == null) {
    // Конкурентов не нашли (или ты уже единственный продавец) — цену не трогаем.
    newPrice = product.currentKaspiPrice ?? product.minPrice;
  } else {
    const desiredPrice = lowestCompetitorPrice - product.repriceStep;
    if (desiredPrice < product.minPrice) {
      newPrice = product.minPrice;
      hitFloor = true;
    } else {
      newPrice = desiredPrice;
    }
  }

  const changed = newPrice !== product.currentKaspiPrice;

  return {
    productId: product.id,
    sku: product.sku,
    oldPrice: product.currentKaspiPrice,
    newPrice,
    lowestCompetitorPrice,
    hitFloor,
    changed,
  };
}

/** Прогоняет автобот по всем товарам, у которых включён autoRepriceEnabled. */
export async function runRepricingCycle(): Promise<RepriceResult[]> {
  const products = await prisma.product.findMany({
    where: { autoRepriceEnabled: true, active: true },
  });

  const results: RepriceResult[] = [];

  for (const product of products) {
    const result = await repriceProduct(product);
    if (!result) continue;
    results.push(result);

    if (result.changed) {
      await prisma.$transaction([
        prisma.product.update({
          where: { id: product.id },
          data: { currentKaspiPrice: result.newPrice, lastRepricedAt: new Date() },
        }),
        prisma.priceHistory.create({
          data: {
            productId: product.id,
            oldPrice: result.oldPrice,
            newPrice: result.newPrice,
            lowestCompetitorPrice: result.lowestCompetitorPrice,
            hitFloor: result.hitFloor,
          },
        }),
      ]);
      logger.info(
        `[Repricer] ${product.sku}: ${result.oldPrice ?? '—'} → ${result.newPrice} ₸` +
          (result.hitFloor ? ' (упёрлись в минимальную цену)' : ''),
      );
    }
  }

  return results;
}
