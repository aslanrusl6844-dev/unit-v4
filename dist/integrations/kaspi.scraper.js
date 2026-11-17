"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchProductPageInfo = fetchProductPageInfo;
exports.fetchCompetitorPrices = fetchCompetitorPrices;
exports.fetchProductImages = fetchProductImages;
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const logger_1 = require("../utils/logger");
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
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/**
 * Читает базовую информацию о товаре (название, цену, рейтинг, число
 * отзывов) со страницы kaspi.kz. У Kaspi нет API для отзывов у партнёров —
 * поэтому берём то же, что видят поисковики: структурированную разметку
 * schema.org/Product (JSON-LD), которую сайты обычно кладут в обычный HTML
 * специально для SEO — она не требует выполнения JavaScript и не зависит
 * от логина в кабинет.
 */
async function fetchProductPageInfo(productUrl) {
    try {
        const { data: html } = await axios_1.default.get(productUrl, {
            headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru' },
            timeout: 15000,
        });
        const $ = cheerio.load(html);
        const result = {};
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).contents().text());
                const items = Array.isArray(json) ? json : [json];
                for (const item of items) {
                    if (item['@type'] === 'Product' || item['@type']?.includes?.('Product')) {
                        result.name = result.name ?? item.name;
                        const offerPrice = item.offers?.price ?? item.offers?.[0]?.price;
                        if (offerPrice)
                            result.price = Number(offerPrice);
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
                            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                            .map((c) => c.name || c.item?.name)
                            .filter(Boolean);
                        if (crumbs.length >= 2 && !result.category) {
                            result.category = crumbs[crumbs.length - 2];
                        }
                    }
                }
            }
            catch {
                // JSON-LD блок не распарсился — пропускаем, пробуем следующий
            }
        });
        // Фоллбэк на title/og-теги, если структурированных данных не нашлось.
        if (!result.name) {
            result.name = $('meta[property="og:title"]').attr('content') || $('title').text() || undefined;
        }
        if (!result.price) {
            const priceMeta = $('meta[property="product:price:amount"]').attr('content');
            if (priceMeta)
                result.price = Number(priceMeta);
        }
        return result;
    }
    catch (err) {
        logger_1.logger.warn({ err, productUrl }, '[Kaspi] Не удалось прочитать информацию о товаре');
        return {};
    }
}
async function fetchCompetitorPrices(productUrl) {
    try {
        const { data: html } = await axios_1.default.get(productUrl, {
            headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru' },
            timeout: 15000,
        });
        const $ = cheerio.load(html);
        const prices = [];
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
                if (price > 100)
                    prices.push({ price });
            }
        }
        const unique = Array.from(new Set(prices.map((p) => p.price))).map((price) => ({ price }));
        logger_1.logger.debug(`[Repricer] Найдено цен на странице: ${unique.length}`);
        return unique.sort((a, b) => a.price - b.price);
    }
    catch (err) {
        logger_1.logger.warn({ err, productUrl }, '[Repricer] Не удалось прочитать страницу товара');
        return [];
    }
}
/**
 * Фото товара со страницы kaspi.kz (публичная страница, только чтение).
 * Официальный API Kaspi фото товаров не отдаёт, поэтому — то же, что видят
 * поисковики: JSON-LD schema.org/Product (поле image), запасной вариант —
 * og:image. Возвращает:
 *   string[] — фото найдены (главное первым), либо [] — страница открылась,
 *              но фото на ней нет;
 *   null     — страницу прочитать не удалось (сеть/блокировка/таймаут) —
 *              вызывающий код НЕ должен считать такой товар "проверенным".
 * Таймаут короткий (6 c) — вызывается пачкой из serverless-функции.
 */
async function fetchProductImages(productUrl) {
    try {
        const { data: html } = await axios_1.default.get(productUrl, {
            headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru' },
            timeout: 6000,
        });
        const $ = cheerio.load(html);
        const urls = [];
        const push = (v) => {
            if (typeof v === 'string' && /^https?:\/\//.test(v.trim()))
                urls.push(v.trim());
            else if (v && typeof v === 'object' && typeof v.url === 'string')
                push(v.url);
        };
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).contents().text());
                const items = Array.isArray(json) ? json : [json];
                for (const item of items) {
                    if (item['@type'] === 'Product' || item['@type']?.includes?.('Product')) {
                        const img = item.image;
                        if (Array.isArray(img))
                            img.forEach(push);
                        else
                            push(img);
                    }
                }
            }
            catch {
                // блок JSON-LD не распарсился — пробуем следующий / og:image
            }
        });
        if (!urls.length)
            push($('meta[property="og:image"]').attr('content'));
        return Array.from(new Set(urls)).slice(0, 10);
    }
    catch (err) {
        logger_1.logger.warn({ err: String(err?.message ?? err), productUrl }, '[Kaspi] Не удалось прочитать фото товара со страницы');
        return null;
    }
}
//# sourceMappingURL=kaspi.scraper.js.map