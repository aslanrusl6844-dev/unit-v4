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
  hitCeiling: boolean;
  changed: boolean;
}

export type RepriceStrategy = 'FIRST_PLACE' | 'MATCH_FIRST' | 'STICK_TO_FIRST' | 'SECOND_PLACE';

interface RepriceableProduct {
  id: string;
  sku: string;
  kaspiProductUrl: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  repriceStep: number;
  repriceStrategy: RepriceStrategy;
  currentKaspiPrice: number | null;
}

/**
 * Считает "желаемую" цену по выбранной стратегии — ДО применения границ
 * min/max. Стратегии — как в форме добавления правила:
 *  - FIRST_PLACE («Быть на 1-м месте»): дешевле лидера на шаг
 *  - MATCH_FIRST («Цена конкурента на 1 месте»): точно как у лидера
 *  - STICK_TO_FIRST («Прижиматься к первому»): как FIRST_PLACE, но не
 *    дёргает цену, если и так укладывается в шаг от лидера (меньше лишних
 *    изменений цены)
 *  - SECOND_PLACE («Быть 2-м»): чуть дороже лидера, но дешевле остальных —
 *    если конкурент всего один, встаёт на шаг выше него
 */
function calculateDesiredPrice(
  strategy: RepriceStrategy,
  sortedCompetitorPrices: number[],
  step: number,
  currentPrice: number | null,
): number | null {
  if (sortedCompetitorPrices.length === 0) return null;
  const [first, second] = sortedCompetitorPrices;

  switch (strategy) {
    case 'MATCH_FIRST':
      return first;

    case 'STICK_TO_FIRST': {
      const desired = first - step;
      if (currentPrice != null && Math.abs(currentPrice - desired) <= step) {
        return currentPrice; // уже в допустимом диапазоне — не дёргаем цену
      }
      return desired;
    }

    case 'SECOND_PLACE':
      return second != null ? second : first + step;

    case 'FIRST_PLACE':
    default:
      return first - step;
  }
}

/**
 * Считает новую цену для одного товара:
 * - находит цены конкурентов на странице;
 * - применяет выбранную стратегию (см. calculateDesiredPrice);
 * - ограничивает результат диапазоном [minPrice, maxPrice] — НИКОГДА не
 *   опускается ниже minPrice (защита от продажи в убыток) и не поднимается
 *   выше maxPrice, если он задан.
 */
export async function repriceProduct(product: RepriceableProduct): Promise<RepriceResult | null> {
  if (!product.kaspiProductUrl) {
    logger.warn(`[Repricer] У товара ${product.sku} не указана ссылка kaspiProductUrl — пропуск`);
    return null;
  }
  if (product.minPrice == null) {
    logger.warn(`[Repricer] У товара ${product.sku} не задана минимальная цена (minPrice) — пропуск, чтобы не уйти в убыток`);
    return null;
  }

  const competitors = await fetchCompetitorPrices(product.kaspiProductUrl);
  const otherPrices = competitors
    .filter((c) => c.price !== product.currentKaspiPrice)
    .map((c) => c.price)
    .sort((a, b) => a - b);

  const lowestCompetitorPrice = otherPrices.length > 0 ? otherPrices[0] : null;
  const desired = calculateDesiredPrice(product.repriceStrategy, otherPrices, product.repriceStep, product.currentKaspiPrice);

  let newPrice: number;
  let hitFloor = false;
  let hitCeiling = false;

  if (desired == null) {
    // Конкурентов не нашли — цену не трогаем.
    newPrice = product.currentKaspiPrice ?? product.minPrice;
  } else if (desired < product.minPrice) {
    newPrice = product.minPrice;
    hitFloor = true;
  } else if (product.maxPrice != null && desired > product.maxPrice) {
    newPrice = product.maxPrice;
    hitCeiling = true;
  } else {
    newPrice = desired;
  }

  const changed = newPrice !== product.currentKaspiPrice;

  return {
    productId: product.id,
    sku: product.sku,
    oldPrice: product.currentKaspiPrice,
    newPrice,
    lowestCompetitorPrice,
    hitFloor,
    hitCeiling,
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
    const result = await repriceProduct(product as RepriceableProduct);
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
        `[Repricer] ${product.sku} (${product.repriceStrategy}): ${result.oldPrice ?? '—'} → ${result.newPrice} ₸` +
          (result.hitFloor ? ' (упёрлись в минимальную цену)' : '') +
          (result.hitCeiling ? ' (упёрлись в максимальную цену)' : ''),
      );
    }
  }

  return results;
}
