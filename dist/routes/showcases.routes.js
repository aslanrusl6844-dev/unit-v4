"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TICKER_DEFAULT_SIZE = exports.showcasesRouter = void 0;
exports.tickerOf = tickerOf;
const express_1 = require("express");
const prisma_1 = require("../db/prisma");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const showcases_errors_1 = require("./showcases.errors");
const productExtras_1 = require("../services/productExtras");
const showcaseBanners_1 = require("../services/showcaseBanners");
const shop_routes_1 = require("./shop.routes");
/**
 * Подбаннерные витрины брендов и магазинов — ПУБЛИЧНАЯ часть для приложения.
 * Путь: /api/shop/showcases/... Доступ — тот же x-app-key, что у /api/shop/*
 * (проверка своя, как у yardRouter). Здесь только чтение и только опубликованное;
 * никаких административных полей (published, sortOrder, даты, id связей) наружу
 * не отдаётся. Управление витринами — showcasesAdmin.routes.ts (вход Basic).
 *
 * Товары витрины = ТОЛЬКО явные привязки (ShowcaseProduct / ShowcaseCollectionItem),
 * никакого подбора по названию. Видимость самого товара — общий фильтр каталога
 * SHOP_VISIBLE_IN_SHOWCASE_WHERE (те же правила видимости, но товары «только для витрин» допускаются): скрытый/архивный товар в витрине не показывается, но
 * привязка при этом не теряется.
 */
exports.showcasesRouter = (0, express_1.Router)();
exports.showcasesRouter.use((req, res, next) => {
    if (!env_1.env.shopAppKey) {
        return res.status(503).json({ error: 'SHOP_APP_KEY не настроен на сервере — API My Market недоступен' });
    }
    if (req.header('x-app-key') !== env_1.env.shopAppKey) {
        return res.status(401).json({ error: 'Неверный или отсутствующий заголовок x-app-key' });
    }
    next();
});
/** Витрина для списка/шапки — только публичные поля. */
/** Бегущая строка витрины: по умолчанию чёрная полоса, белые буквы, шрифт 20. */
exports.TICKER_DEFAULT_SIZE = 20;
function tickerOf(s) {
    const text = typeof s.tickerText === 'string' ? s.tickerText.trim() : '';
    const hex = (v, fallback) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback);
    const size = Number.isInteger(s.tickerSize) && s.tickerSize >= 8 && s.tickerSize <= 60 ? s.tickerSize : exports.TICKER_DEFAULT_SIZE;
    return text
        ? { tickerText: text, tickerBg: hex(s.tickerBg, '#000000'), tickerColor: hex(s.tickerColor, '#FFFFFF'), tickerSize: size }
        : { tickerText: null, tickerBg: null, tickerColor: null, tickerSize: null };
}
function publicShowcase(s) {
    return {
        id: s.id,
        type: s.type,
        title: s.title,
        description: s.description ?? null,
        logoUrl: s.logoUrl ?? null,
        bannerUrl: s.bannerUrl ?? null,
        bannerTitle: s.bannerTitle ?? null,
        bannerText: s.bannerText ?? null,
    };
}
/**
 * Загружает видимые товары ОДНИМ набором запросов и отдаёт карту id → товар в
 * формате каталога. Невидимые (нет в каталоге / не в продаже / архив / без цены)
 * в карту не попадают. Порядок задаёт вызывающий код.
 */
async function loadVisibleProductMap(productIds) {
    const out = new Map();
    const ids = Array.from(new Set(productIds));
    if (ids.length === 0)
        return out;
    const rows = await prisma_1.prisma.product.findMany({ where: { AND: [shop_routes_1.SHOP_VISIBLE_IN_SHOWCASE_WHERE, { id: { in: ids } }] } });
    const withArticles = await Promise.all(rows.map((r) => (0, shop_routes_1.ensureShopArticle)(r)));
    const statsMap = await (0, shop_routes_1.getReviewStatsMap)(withArticles);
    const variantsMap = await (0, shop_routes_1.getProductVariantsMap)(withArticles);
    for (const p of withArticles)
        out.set(p.id, { ...(0, shop_routes_1.toShopProduct)(p), ...statsMap.get(p.id), variants: variantsMap.get(p.id) });
    return out;
}
/** Видимые товары СТРОГО в порядке списка id; невидимые пропускаются. */
async function loadVisibleProductsInOrder(productIds) {
    const map = await loadVisibleProductMap(productIds);
    return productIds.filter((id) => map.has(id)).map((id) => map.get(id));
}
/** Опубликованная витрина по id или null (скрытая для приложения не существует). */
async function findPublished(id) {
    return prisma_1.prisma.showcase.findFirst({ where: { id, published: true } });
}
/** Список опубликованных витрин — иконки под главным баннером. */
exports.showcasesRouter.get('/', async (_req, res) => {
    try {
        const rows = await prisma_1.prisma.showcase.findMany({
            where: { published: true },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        res.json(rows.map(publicShowcase));
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Showcases API] GET / упал');
        const mapped = (0, showcases_errors_1.mapDbError)(err);
        if (mapped)
            return res.status(mapped.status === 404 ? 500 : mapped.status).json(mapped.body);
        res.status(500).json({ error: 'Не удалось получить витрины' });
    }
});
/** Страница витрины: шапка, баннер и опубликованные подборки с товарами. */
exports.showcasesRouter.get('/:id', async (req, res) => {
    try {
        const showcase = await findPublished(req.params.id);
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const collections = await prisma_1.prisma.showcaseCollection.findMany({
            where: { showcaseId: showcase.id, published: true },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
        });
        const links = await prisma_1.prisma.showcaseProduct.findMany({
            where: { showcaseId: showcase.id },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        // Один набор запросов на всю страницу (товары витрины + подборки), а не по запросу на каждую.
        const map = await loadVisibleProductMap([
            ...links.map((l) => l.productId),
            ...collections.flatMap((c) => c.items.map((i) => i.productId)),
        ]);
        const outCollections = [];
        for (const c of collections) {
            const products = c.items.map((i) => map.get(i.productId)).filter((x) => x !== undefined);
            // Пустая подборка (все товары скрыты) покупателю не нужна.
            if (products.length > 0)
                outCollections.push({ id: c.id, title: c.title, products });
        }
        // banners / videoUrl — только на странице витрины; список (иконки) не меняется.
        // bigBanners — большая карусель сверху (пусто → запасной bannerUrl, как раньше);
        // smallBanners — маленькая карусель ниже (то же, что banners, оставлено для совместимости).
        const smallBanners = Array.isArray(showcase.banners) ? showcase.banners : [];
        const bigItems = (0, showcaseBanners_1.bigBannerItemsOf)(showcase); // {url, text, sizes, textColor}; пусто → запасной bannerUrl
        res.json({
            ...publicShowcase(showcase),
            // bigBanners — только ссылки (как раньше); bigBannerItems — те же баннеры с текстом (многострочный, \n), sizes (размер в % для каждой строки; по умолчанию 20) и цветом текста.
            bigBanners: bigItems.map((b) => b.url),
            bigBannerItems: bigItems,
            smallBanners,
            // До 20 видео витрины (URL); нет видео — [].
            videos: (0, productExtras_1.parseVideos)(showcase.videos, productExtras_1.MAX_SHOWCASE_VIDEOS),
            banners: smallBanners,
            videoUrl: showcase.videoUrl ?? null,
            // Бегущая строка: текст и цвета (текст пуст → null и цвета null; строки в приложении нет).
            ...tickerOf(showcase),
            // Товары именно этой витрины в порядке админки (видимые покупателю); нет товаров — [].
            products: links
                .map((l) => map.get(l.productId))
                .filter((x) => x !== undefined)
                .map((p) => ({ ...p, image: Array.isArray(p.images) && p.images.length ? p.images[0] : null, shopArticle: p.article ?? null })),
            collections: outCollections,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Showcases API] GET /:id упал');
        const mapped = (0, showcases_errors_1.mapDbError)(err);
        if (mapped)
            return res.status(mapped.status === 404 ? 500 : mapped.status).json(mapped.body);
        res.status(500).json({ error: 'Не удалось получить витрину' });
    }
});
/**
 * Каталог товаров витрины. Порядок по умолчанию — заданный администратором.
 * Необязательно: ?q= (поиск по названию), ?sort=price_asc|price_desc|name.
 */
exports.showcasesRouter.get('/:id/products', async (req, res) => {
    try {
        const showcase = await findPublished(req.params.id);
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const links = await prisma_1.prisma.showcaseProduct.findMany({
            where: { showcaseId: showcase.id },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        let products = await loadVisibleProductsInOrder(links.map((l) => l.productId));
        const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
        if (q)
            products = products.filter((p) => String(p.name ?? '').toLowerCase().includes(q));
        const sort = typeof req.query.sort === 'string' ? req.query.sort : '';
        if (sort === 'price_asc')
            products = [...products].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
        else if (sort === 'price_desc')
            products = [...products].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
        else if (sort === 'name')
            products = [...products].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
        res.json(products);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Showcases API] GET /:id/products упал');
        const mapped = (0, showcases_errors_1.mapDbError)(err);
        if (mapped)
            return res.status(mapped.status === 404 ? 500 : mapped.status).json(mapped.body);
        res.status(500).json({ error: 'Не удалось получить товары витрины' });
    }
});
//# sourceMappingURL=showcases.routes.js.map