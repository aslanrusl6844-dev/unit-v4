import { prisma } from '../db/prisma';
import { fetchProductPageInfo, fetchCompetitorPrices } from '../integrations/kaspi.scraper';
import { calcKaspiCommissionAmount, getKaspiCommissionRate, KASPI_TOP_CATEGORY_RATE } from '../integrations/kaspi.categories';
import { calculateKaspiDeliveryCost } from '../integrations/kaspi.delivery';
import { getTaxRatePct } from '../handlers/taxSettings';
import { getProductForecasts } from './analytics.service';
import { logger } from '../utils/logger';

/**
 * Анализ ниши/товара Kaspi — ТОЛЬКО Kaspi, Ozon/WB не участвуют.
 *
 * ЧЕСТНО про точность (см. также подсказки в самом интерфейсе):
 *  - У официального Kaspi Partner API нет ни одного метода, отдающего
 *    данные о ЧУЖИХ товарах (продажи, выручка, число продавцов и т.д.) —
 *    он даёт доступ только к твоему собственному магазину. Поэтому все
 *    цифры по чужому товару ниже — ОЦЕНКА по публичной странице (то же,
 *    что видит любой покупатель), не выгрузка из кабинета конкурента.
 *  - Исключение: если артикул уже есть В ТВОЁМ каталоге — для него
 *    показываются точные цифры из реальной юнит-экономики (см. isOwnProduct).
 *  - "Продажи/выручка за 30 дней" — грубая оценка по числу отзывов
 *    (общепринятая в e-commerce эвристика: не все покупатели оставляют
 *    отзыв, обычно единицы процентов). Kaspi не публикует дату каждого
 *    отзыва, поэтому мы не можем достоверно знать, сколько из них — именно
 *    за последние 30 дней. Множитель ниже — открыто прописанное
 *    предположение, а не откалиброванный по Kaspi коэффициент.
 */

// ЧЕСТНО ПРОПИСАННОЕ ПРЕДПОЛОЖЕНИЕ (не калибровка Kaspi): считаем, что
// отзыв оставляет в среднем 1 из 30 покупателей, и отзывы этого товара
// набирались в среднем за последние ~3 месяца. Оба числа — грубая оценка,
// реальные цифры для конкретного товара могут отличаться в разы.
const REVIEWS_PER_SALE = 30;
const ASSUMED_MONTHS_ACCUMULATED = 3;

export interface NicheAnalysisResult {
  input: string;
  resolvedUrl: string;
  productName: string | null;
  category: string | null;
  sellerCount: number | null;
  priceMin: number | null;
  priceMax: number | null;
  priceMedian: number | null;
  ratingValue: number | null;
  reviewCount: number | null;
  estimatedMonthlySales: number | null;
  estimatedMonthlyRevenue: number | null;
  commissionRatePct: number | null;
  estimatedMonthlyCommission: number | null;
  estimatedMonthlyLogistics: number | null;
  taxRatePct: number;
  estimatedMonthlyTax: number | null;
  estimatedMonthlyNetProfit: number | null;
  verdict: 'strong' | 'medium' | 'weak' | 'unknown';
  verdictReason: string;
  isOwnProduct: boolean;
  ownProductExactData: null | {
    referencePrice: number | null;
    estCommission: number | null;
    estLogistics: number | null;
    estTax: number | null;
    estPayout: number | null;
    estMarginAfterTaxPct: number | null;
  };
  dataQualityWarning: string;
}

/** Kaspi не даёт искать товар по одному артикулу без URL — но публичные
 *  ссылки на карточку товара обычно резолвятся и без SEO-текста в слаге,
 *  просто по числовому id в конце. Пробуем такой шаблон, если пользователь
 *  ввёл только артикул (только цифры), а не полную ссылку. */
function resolveUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `https://kaspi.kz/shop/p/-${trimmed}/`;
  return trimmed;
}

function extractArticleFromUrl(url: string): string | null {
  const match = url.match(/-(\d{5,})\/?(?:\?|$)/);
  return match ? match[1] : null;
}

/** Пробуем сопоставить свободный текст категории со страницы с нашей
 *  таблицей верхних категорий Kaspi (для точного расчёта комиссии). Если
 *  не совпало ни одно — считаем по безопасному дефолту (как везде в проекте). */
function matchTopCategory(scrapedCategory: string | undefined): string | undefined {
  if (!scrapedCategory) return undefined;
  const normalized = scrapedCategory.trim().toLowerCase();
  const match = Object.keys(KASPI_TOP_CATEGORY_RATE).find(
    (top) => top.toLowerCase() === normalized || normalized.includes(top.toLowerCase()) || top.toLowerCase().includes(normalized),
  );
  return match;
}

export async function analyzeNiche(rawInput: string): Promise<NicheAnalysisResult> {
  const url = resolveUrl(rawInput);
  const article = extractArticleFromUrl(url) ?? (/^\d+$/.test(rawInput.trim()) ? rawInput.trim() : null);

  const [pageInfo, competitorPrices, taxRatePct] = await Promise.all([
    fetchProductPageInfo(url),
    fetchCompetitorPrices(url),
    getTaxRatePct(),
  ]);

  const sellerCount = competitorPrices.length || null;
  const priceMin = competitorPrices.length ? competitorPrices[0].price : (pageInfo.price ?? null);
  const priceMax = competitorPrices.length ? competitorPrices[competitorPrices.length - 1].price : (pageInfo.price ?? null);
  const priceMedian = competitorPrices.length
    ? competitorPrices[Math.floor(competitorPrices.length / 2)].price
    : (pageInfo.price ?? null);

  // Если этот артикул уже есть в НАШЕМ каталоге — для него есть точные
  // цифры реальной юнит-экономики (не оценка). Показываем ОБА блока:
  // общую оценку ниши (по рынку) и точные цифры конкретно нашего товара.
  let isOwnProduct = false;
  let ownProductExactData: NicheAnalysisResult['ownProductExactData'] = null;
  if (article) {
    const ownProduct = await prisma.product.findFirst({ where: { kaspiSku: article } });
    if (ownProduct) {
      isOwnProduct = true;
      const forecasts = await getProductForecasts(taxRatePct);
      const fc = forecasts.find((f) => f.productId === ownProduct.id && f.marketplace === 'KASPI');
      if (fc) {
        ownProductExactData = {
          referencePrice: fc.referencePrice,
          estCommission: fc.estCommission,
          estLogistics: fc.estLogistics,
          estTax: fc.estTax,
          estPayout: fc.estPayout,
          estMarginAfterTaxPct: fc.estMarginAfterTaxPct,
        };
      }
    }
  }

  // Оценка продаж/выручки — см. предупреждение в шапке файла. Используем
  // медианную цену рынка (не обязательно нашу), т.к. это анализ НИШИ.
  const referencePriceForEstimate = priceMedian ?? pageInfo.price ?? null;
  let estimatedMonthlySales: number | null = null;
  let estimatedMonthlyRevenue: number | null = null;
  if (pageInfo.reviewCount != null && pageInfo.reviewCount > 0) {
    const estimatedTotalSales = pageInfo.reviewCount * REVIEWS_PER_SALE;
    estimatedMonthlySales = Math.round(estimatedTotalSales / ASSUMED_MONTHS_ACCUMULATED);
    if (referencePriceForEstimate) {
      estimatedMonthlyRevenue = Math.round(estimatedMonthlySales * referencePriceForEstimate);
    }
  }

  // Комиссия/логистика/налог — точные ОФИЦИАЛЬНЫЕ формулы (та же логика,
  // что и в analytics.service.ts), примененные к ОЦЕНОЧНОМУ обороту ниши.
  const matchedTopCategory = matchTopCategory(pageInfo.category);
  const commissionRatePct = getKaspiCommissionRate({ topCategory: matchedTopCategory ?? '', leafCategory: pageInfo.category });

  let estimatedMonthlyCommission: number | null = null;
  let estimatedMonthlyLogistics: number | null = null;
  let estimatedMonthlyTax: number | null = null;
  let estimatedMonthlyNetProfit: number | null = null;

  if (estimatedMonthlyRevenue != null) {
    estimatedMonthlyCommission = Math.round(calcKaspiCommissionAmount(estimatedMonthlyRevenue, {
      topCategory: matchedTopCategory ?? '',
      leafCategory: pageInfo.category,
    }));
    // Логистику на масштаб ниши (не одной покупки) оцениваем по тому же
    // тарифу, что и остальной проект — среднему чеку в зоне "по Казахстану".
    const avgCheckLogistics = referencePriceForEstimate
      ? calculateKaspiDeliveryCost(referencePriceForEstimate, 0.5, 'kazakhstan')
      : 0;
    estimatedMonthlyLogistics = Math.round(avgCheckLogistics * (estimatedMonthlySales ?? 0));
    estimatedMonthlyTax = Math.round(estimatedMonthlyRevenue * (taxRatePct / 100));
    estimatedMonthlyNetProfit = Math.round(
      estimatedMonthlyRevenue - estimatedMonthlyCommission - estimatedMonthlyLogistics - estimatedMonthlyTax,
    );
  }

  // Вердикт — по марже (после налога) и уровню конкуренции (число продавцов
  // на карточке). Это ЭВРИСТИКА для быстрой прикидки, не строгий скоринг.
  let verdict: NicheAnalysisResult['verdict'] = 'unknown';
  let verdictReason = 'Недостаточно данных для оценки (не удалось прочитать страницу или нет отзывов).';
  if (estimatedMonthlyRevenue != null && estimatedMonthlyNetProfit != null) {
    const marginPct = estimatedMonthlyRevenue > 0 ? (estimatedMonthlyNetProfit / estimatedMonthlyRevenue) * 100 : 0;
    const highCompetition = (sellerCount ?? 0) > 12;
    if (marginPct >= 25 && !highCompetition) {
      verdict = 'strong';
      verdictReason = `Оценочная маржа ~${Math.round(marginPct)}% при умеренной конкуренции (${sellerCount ?? '—'} продавцов).`;
    } else if (marginPct >= 10 && (sellerCount ?? 0) <= 20) {
      verdict = 'medium';
      verdictReason = `Оценочная маржа ~${Math.round(marginPct)}%, конкуренция ${sellerCount ?? '—'} продавцов — нужно точнее считать себестоимость перед решением.`;
    } else {
      verdict = 'weak';
      verdictReason = highCompetition
        ? `Высокая конкуренция (${sellerCount} продавцов) — сложно выделиться ценой.`
        : `Оценочная маржа всего ~${Math.round(marginPct)}% — риск уйти в минус при реальной себестоимости.`;
    }
  }

  if (!pageInfo.name) {
    logger.warn({ url }, '[Ниши] Не удалось прочитать страницу товара Kaspi');
  }

  return {
    input: rawInput,
    resolvedUrl: url,
    productName: pageInfo.name ?? null,
    category: pageInfo.category ?? null,
    sellerCount,
    priceMin,
    priceMax,
    priceMedian,
    ratingValue: pageInfo.ratingValue ?? null,
    reviewCount: pageInfo.reviewCount ?? null,
    estimatedMonthlySales,
    estimatedMonthlyRevenue,
    commissionRatePct,
    estimatedMonthlyCommission,
    estimatedMonthlyLogistics,
    taxRatePct,
    estimatedMonthlyTax,
    estimatedMonthlyNetProfit,
    verdict,
    verdictReason,
    isOwnProduct,
    ownProductExactData,
    dataQualityWarning:
      'Продажи и выручка — ГРУБАЯ оценка по числу отзывов (Kaspi не публикует ни продажи, ни даты отзывов). ' +
      'Комиссия и налог посчитаны по официальным формулам, но применены к оценочному, а не реальному обороту.',
  };
}
