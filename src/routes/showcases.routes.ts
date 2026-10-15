import { Router } from 'express';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { mapDbError } from './showcases.errors';
import {
  SHOP_VISIBLE_WHERE,
  toShopProduct,
  ensureShopArticle,
  getReviewStatsMap,
  getProductVariantsMap,
} from './shop.routes';

/**
 * Подбаннерные витрины брендов и магазинов — ПУБЛИЧНАЯ часть для приложения.
 * Путь: /api/shop/showcases/... Доступ — тот же x-app-key, что у /api/shop/*
 * (проверка своя, как у yardRouter). Здесь только чтение и только опубликованное;
 * никаких административных полей (published, sortOrder, даты, id связей) наружу
 * не отдаётся. Управление витринами — showcasesAdmin.routes.ts (вход Basic).
 *
 * Товары витрины = ТОЛЬКО явные привязки (ShowcaseProduct / ShowcaseCollectionItem),
 * никакого подбора по названию. Видимость самого товара — общий фильтр каталога
 * SHOP_VISIBLE_WHERE: скрытый/архивный товар в витрине не показывается, но
 * привязка при этом не теряется.
 */
export const showcasesRouter = Router();

showcasesRouter.use((req, res, next) => {
  if (!env.shopAppKey) {
    return res.status(503).json({ error: 'SHOP_APP_KEY не настроен на сервере — API My Market недоступен' });
  }
  if (req.header('x-app-key') !== env.shopAppKey) {
    return res.status(401).json({ error: 'Неверный или отсутствующий заголовок x-app-key' });
  }
  next();
});

/** Витрина для списка/шапки — только публичные поля. */
function publicShowcase(s: any) {
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
async function loadVisibleProductMap(productIds: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const ids = Array.from(new Set(productIds));
  if (ids.length === 0) return out;
  const rows: any[] = await prisma.product.findMany({ where: { AND: [SHOP_VISIBLE_WHERE, { id: { in: ids } }] } });
  const withArticles: any[] = await Promise.all(rows.map((r) => ensureShopArticle(r)));
  const statsMap = await getReviewStatsMap(withArticles);
  const variantsMap = await getProductVariantsMap(withArticles);
  for (const p of withArticles) out.set(p.id, { ...toShopProduct(p), ...statsMap.get(p.id), variants: variantsMap.get(p.id) });
  return out;
}

/** Видимые товары СТРОГО в порядке списка id; невидимые пропускаются. */
async function loadVisibleProductsInOrder(productIds: string[]) {
  const map = await loadVisibleProductMap(productIds);
  return productIds.filter((id) => map.has(id)).map((id) => map.get(id));
}

/** Опубликованная витрина по id или null (скрытая для приложения не существует). */
async function findPublished(id: string) {
  return prisma.showcase.findFirst({ where: { id, published: true } });
}

/** Список опубликованных витрин — иконки под главным баннером. */
showcasesRouter.get('/', async (_req, res) => {
  try {
    const rows = await prisma.showcase.findMany({
      where: { published: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(rows.map(publicShowcase));
  } catch (err: any) {
    logger.error({ err }, '[Showcases API] GET / упал');
    const mapped = mapDbError(err);
    if (mapped) return res.status(mapped.status === 404 ? 500 : mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Не удалось получить витрины' });
  }
});

/** Страница витрины: шапка, баннер и опубликованные подборки с товарами. */
showcasesRouter.get('/:id', async (req, res) => {
  try {
    const showcase = await findPublished(req.params.id);
    if (!showcase) return res.status(404).json({ error: 'Витрина не найдена' });
    const collections = await prisma.showcaseCollection.findMany({
      where: { showcaseId: showcase.id, published: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    // Один набор запросов на всю страницу, а не по запросу на каждую подборку.
    const map = await loadVisibleProductMap(collections.flatMap((c: any) => c.items.map((i: any) => i.productId)));
    const outCollections: any[] = [];
    for (const c of collections) {
      const products = c.items.map((i: any) => map.get(i.productId)).filter((x: any) => x !== undefined);
      // Пустая подборка (все товары скрыты) покупателю не нужна.
      if (products.length > 0) outCollections.push({ id: c.id, title: c.title, products });
    }
    // banners / videoUrl — только на странице витрины; список (иконки) не меняется.
    res.json({
      ...publicShowcase(showcase),
      banners: Array.isArray(showcase.banners) ? showcase.banners : [],
      videoUrl: showcase.videoUrl ?? null,
      collections: outCollections,
    });
  } catch (err: any) {
    logger.error({ err }, '[Showcases API] GET /:id упал');
    const mapped = mapDbError(err);
    if (mapped) return res.status(mapped.status === 404 ? 500 : mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Не удалось получить витрину' });
  }
});

/**
 * Каталог товаров витрины. Порядок по умолчанию — заданный администратором.
 * Необязательно: ?q= (поиск по названию), ?sort=price_asc|price_desc|name.
 */
showcasesRouter.get('/:id/products', async (req, res) => {
  try {
    const showcase = await findPublished(req.params.id);
    if (!showcase) return res.status(404).json({ error: 'Витрина не найдена' });
    const links = await prisma.showcaseProduct.findMany({
      where: { showcaseId: showcase.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    let products = await loadVisibleProductsInOrder(links.map((l: any) => l.productId));

    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    if (q) products = products.filter((p) => String(p.name ?? '').toLowerCase().includes(q));

    const sort = typeof req.query.sort === 'string' ? req.query.sort : '';
    if (sort === 'price_asc') products = [...products].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    else if (sort === 'price_desc') products = [...products].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    else if (sort === 'name') products = [...products].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));

    res.json(products);
  } catch (err: any) {
    logger.error({ err }, '[Showcases API] GET /:id/products упал');
    const mapped = mapDbError(err);
    if (mapped) return res.status(mapped.status === 404 ? 500 : mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Не удалось получить товары витрины' });
  }
});
