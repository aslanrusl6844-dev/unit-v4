import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';

/**
 * Читает страницу товара на kaspi.kz (обычную, публичную — ту же, что видит
 * покупатель) и достаёт цены всех продавцов, торгующих этим товаром.
 *
 * ВАЖНО: это не официальный API — Kaspi не предоставляет отдельный
 * эндпоинт "цены конкурентов" для продавцов. Разметка страницы может
 * меняться без предупреждения, тогда парсер придётся поправить (обычно
 * достаточно обновить CSS-селекторы ниже). Не запускайте это слишком
 * часто — раз в 10–20 минут на товар более чем достаточно и не создаёт
 * подозрительной нагрузки на сайт.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface CompetitorPrice {
  price: number;
  sellerName?: string;
}

export interface ProductPageInfo {
  name?: string;
  price?: number;
  ratingValue?: number;
  reviewCount?: number;
  category?: string;
}

/**
 * Читает базовую информацию о товаре (название, цену, рейтинг, число
 * отзывов) со страницы kaspi.kz. У Kaspi нет API для отзывов у партнёров —
 * поэтому берём то же, что видят поисковики: структурированную разметку
 * schema.org/Product (JSON-LD), которую сайты обычно кладут в обычный HTML
 * специально для SEO — она не требует выполнения JavaScript и не зависит
 * от логина в кабинет.
 */
export async function fetchProductPageInfo(productUrl: string): Promise<ProductPageInfo> {
  try {
    const { data: html } = await axios.get<string>(productUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru' },
      timeout: 15000,
    });

    const $ = cheerio.load(html);
    const result: ProductPageInfo = {};

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).contents().text());
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (item['@type'] === 'Product' || item['@type']?.includes?.('Product')) {
            result.name = result.name ?? item.name;
            const offerPrice = item.offers?.price ?? item.offers?.[0]?.price;
            if (offerPrice) result.price = Number(offerPrice);
            if (item.aggregateRating) {
              result.ratingValue = Number(item.aggregateRating.ratingValue) || undefined;
              result.reviewCount = Number(item.aggregateRating.reviewCount ?? item.aggregateRating.ratingCount) || undefined;
            }
            if (item.category && typeof item.category === 'string') {
              result.category = item.category;
            }
          }
          // Хлебные крошки (BreadcrumbList) — часто более надёжный источник
          // категории, чем поле category внутри Product (которое у Kaspi
          // не всегда заполнено). Берём предпоследний уровень — последний
          // обычно совпадает с названием самого товара, не категорией.
          if (item['@type'] === 'BreadcrumbList' && Array.isArray(item.itemListElement)) {
            const crumbs = item.itemListElement
              .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
              .map((c: any) => c.name || c.item?.name)
              .filter(Boolean);
            if (crumbs.length >= 2 && !result.category) {
              result.category = crumbs[crumbs.length - 2];
            }
          }
        }
      } catch {
        // JSON-LD блок не распарсился — пропускаем, пробуем следующий
      }
    });

    // Фоллбэк на title/og-теги, если структурированных данных не нашлось.
    if (!result.name) {
      result.name = $('meta[property="og:title"]').attr('content') || $('title').text() || undefined;
    }
    if (!result.price) {
      const priceMeta = $('meta[property="product:price:amount"]').attr('content');
      if (priceMeta) result.price = Number(priceMeta);
    }

    return result;
  } catch (err) {
    logger.warn({ err, productUrl }, '[Kaspi] Не удалось прочитать информацию о товаре');
    return {};
  }
}

export async function fetchCompetitorPrices(productUrl: string): Promise<CompetitorPrice[]> {
  try {
    const { data: html } = await axios.get<string>(productUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru' },
      timeout: 15000,
    });

    const $ = cheerio.load(html);
    const prices: CompetitorPrice[] = [];

    // Разметка Kaspi время от времени меняется — ищем сразу по нескольким
    // распространённым признакам блока "цена продавца", чтобы парсер был
    // устойчивее к мелким правкам вёрстки.
    $('[class*="seller"], [class*="offer"]').each((_, el) => {
      const text = $(el).find('[class*="price"]').first().text() || $(el).text();
      const match = text.match(/(\d[\d\s]{2,})\s*₸/);
      if (match) {
        const price = Number(match[1].replace(/\s/g, ''));
        if (price > 0) {
          const sellerName = $(el).find('[class*="seller-name"], [class*="merchant-name"]').first().text().trim();
          prices.push({ price, sellerName: sellerName || undefined });
        }
      }
    });

    // Фоллбэк: если специфичные селекторы ничего не нашли, пробуем достать
    // все упоминания цены на странице (менее точно, но лучше, чем ничего).
    if (prices.length === 0) {
      const bodyText = $('body').text();
      const matches = [...bodyText.matchAll(/(\d[\d\s]{2,})\s*₸/g)];
      for (const m of matches.slice(0, 20)) {
        const price = Number(m[1].replace(/\s/g, ''));
        if (price > 100) prices.push({ price });
      }
    }

    const unique = Array.from(new Set(prices.map((p) => p.price))).map((price) => ({ price }));
    logger.debug(`[Repricer] Найдено цен на странице: ${unique.length}`);
    return unique.sort((a, b) => a.price - b.price);
  } catch (err) {
    logger.warn({ err, productUrl }, '[Repricer] Не удалось прочитать страницу товара');
    return [];
  }
}
