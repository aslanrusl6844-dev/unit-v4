import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { mapDbError } from './showcases.errors';
import { videosSchema } from '../services/productExtras';

/**
 * Подбаннерные витрины — АДМИНИСТРАТИВНАЯ часть. Путь: /api/shop-admin/showcases/...
 *
 * Защита: общий вход администратора (Basic, src/middleware/adminAuth.ts) закрывает
 * весь /api/shop-admin/* по умолчанию — здесь отдельной проверки нет и ключ
 * приложения x-app-key к этим маршрутам отношения не имеет.
 *
 * Товары каталога тут НИКОГДА не создаются, не меняются и не удаляются: витрина
 * хранит только явные ссылки (productId) на существующие товары. Удаление витрины,
 * подборки или привязки удаляет только ссылки.
 */
export const showcasesAdminRouter = Router();

const SHOWCASE_TYPES = ['brand', 'shop'] as const;

const imageUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), 'Ссылка на картинку должна начинаться с http:// или https://');
const MAX_BANNERS = 10;
const bannersSchema = z.array(imageUrl).max(MAX_BANNERS, `Не больше ${MAX_BANNERS} баннеров`);
const videoUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Ссылка на видео должна начинаться с http:// или https://')
  .nullable()
  .optional();
/** Без повторов, порядок сохраняется. */
function uniqueUrls(list: string[]): string[] {
  return Array.from(new Set(list));
}
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const title = z.string().trim().min(1, 'Название обязательно').max(120);
const productIdSchema = z.string().trim().min(1).max(100);
const idList = z.object({ ids: z.array(z.string().min(1).max(100)).max(1000) });

/** '' и null одинаково очищают необязательное поле. */
function blankToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return v.trim() === '' ? null : v.trim();
}

function fail(res: Response, req: Request, err: any, what: string) {
  logger.error({ err }, `[Showcases Admin] ${req.method} ${req.path} упал`);
  // Понятные ответы вместо общего 500: запись уже удалена (P2025), дубль (P2002), таблицы не созданы (P2021/P2022).
  const mapped = mapDbError(err);
  if (mapped) return res.status(mapped.status).json(mapped.body);
  res.status(500).json({ error: what, details: String(err?.message ?? err) });
}

/** Лимиты, чтобы страница витрины для приложения не раздувалась. */
export const MAX_PRODUCTS_PER_LIST = 500;
export const MAX_COLLECTIONS_PER_SHOWCASE = 30;

/**
 * Новый порядок должен быть ПОЛНЫМ списком текущих элементов: неизвестный id → 400,
 * неполный список (кто-то успел добавить/удалить) → 409 STALE_ORDER — иначе порядок
 * получился бы с повторяющимися номерами.
 */
function checkFullOrder(res: Response, current: string[], wanted: string[], unknownMsg: string): boolean {
  const cur = new Set(current);
  if (wanted.some((id) => !cur.has(id))) {
    res.status(400).json({ error: unknownMsg });
    return false;
  }
  if (wanted.length !== current.length) {
    res.status(409).json({ error: 'Список изменился — обновите страницу и повторите', code: 'STALE_ORDER' });
    return false;
  }
  return true;
}

function isUniqueViolation(err: any): boolean {
  return err?.code === 'P2002';
}

function bad(res: Response, parsed: { error: z.ZodError }) {
  return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Неверные данные', details: parsed.error.flatten() });
}

/** Карточка товара для админки: только то, что нужно для выбора и показа в списке. */
function productBrief(p: any) {
  let image: string | null = null;
  try {
    const arr = p.images ? JSON.parse(p.images) : [];
    if (Array.isArray(arr) && typeof arr[0] === 'string') image = arr[0];
  } catch {
    image = null;
  }
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    article: p.shopArticle ?? null,
    price: p.shopPrice ?? null,
    shopActive: !!p.shopActive,
    shopArchived: !!p.shopArchived,
    showcaseOnly: !!p.showcaseOnly,
    category: p.category ?? null,
    image,
  };
}

/** Привязки + карточки товаров в порядке привязок. Удалённый из каталога товар помечается missing. */
async function linkedProducts(links: Array<{ productId: string; sortOrder: number }>) {
  const ids = links.map((l) => l.productId);
  const rows = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } } }) : [];
  const byId = new Map(rows.map((r: any) => [r.id, r]));
  return links.map((l) => {
    const p = byId.get(l.productId);
    return p ? productBrief(p) : { id: l.productId, name: '(товар удалён из каталога)', missing: true };
  });
}

// ---------------------------------------------------------------------------
// Поиск товара каталога для добавления (по названию, id, sku, артикулу витрины)
// ВАЖНО: объявлен раньше '/:id', чтобы 'product-search' не принимался за id.
// ---------------------------------------------------------------------------
showcasesAdminRouter.get('/product-search', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    if (q.length < 1) return res.json([]);
    const rows = await prisma.product.findMany({
      where: {
        OR: [
          { id: q },
          { name: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { shopArticle: { contains: q } },
          { kaspiSku: { contains: q, mode: 'insensitive' } },
          { ozonOfferId: { contains: q, mode: 'insensitive' } },
          { wbArticle: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { name: 'asc' },
      take: 30,
    });
    res.json(rows.map(productBrief));
  } catch (err: any) {
    fail(res, req, err, 'Не удалось выполнить поиск товаров');
  }
});

// ---------------------------------------------------------------------------
// Витрины
// ---------------------------------------------------------------------------
showcasesAdminRouter.get('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rows = await prisma.showcase.findMany({
      where: q ? { title: { contains: q, mode: 'insensitive' } } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { products: true, collections: true } } },
    });
    res.json(rows);
  } catch (err: any) {
    fail(res, req, err, 'Не удалось получить витрины');
  }
});

const createShowcase = z.object({
  type: z.enum(SHOWCASE_TYPES),
  title,
  description: optText(500),
  logoUrl: imageUrl.nullable().optional().or(z.literal('')),
  bannerUrl: imageUrl.nullable().optional().or(z.literal('')),
  bannerTitle: optText(120),
  bannerText: optText(1000),
  banners: bannersSchema.optional(),
  bigBanners: bannersSchema.optional(),
  videos: videosSchema.optional(),
  videoUrl: videoUrlSchema,
  published: z.boolean().optional(),
});

showcasesAdminRouter.post('/', async (req, res) => {
  const parsed = createShowcase.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  try {
    const d = parsed.data;
    const last = await prisma.showcase.findFirst({ orderBy: { sortOrder: 'desc' } });
    const row = await prisma.showcase.create({
      data: {
        type: d.type,
        title: d.title,
        description: blankToNull(d.description) ?? null,
        logoUrl: blankToNull(d.logoUrl) ?? null,
        bannerUrl: blankToNull(d.bannerUrl) ?? null,
        bannerTitle: blankToNull(d.bannerTitle) ?? null,
        bannerText: blankToNull(d.bannerText) ?? null,
        banners: uniqueUrls(d.banners ?? []),
        bigBanners: uniqueUrls(d.bigBanners ?? []),
        videos: d.videos ?? [],
        videoUrl: blankToNull(d.videoUrl) ?? null,
        // Новая витрина по умолчанию скрыта: наполняем, потом публикуем.
        published: d.published ?? false,
        sortOrder: (last?.sortOrder ?? 0) + 1,
      },
    });
    res.status(201).json(row);
  } catch (err: any) {
    fail(res, req, err, 'Не удалось создать витрину');
  }
});

/** Порядок витрин: тело { ids: [...] } — новый порядок сверху вниз. */
showcasesAdminRouter.put('/order', async (req, res) => {
  const parsed = idList.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const ids = parsed.data.ids;
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'В списке есть повторы' });
  try {
    const all = await prisma.showcase.findMany({});
    if (!checkFullOrder(res, all.map((r: any) => r.id), ids, 'В списке есть неизвестная витрина')) return;
    await prisma.$transaction(ids.map((id, i) => prisma.showcase.update({ where: { id }, data: { sortOrder: i + 1 } })));
    res.json({ ok: true });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось изменить порядок витрин');
  }
});

/** Витрина целиком: поля, подборки (с товарами) и список привязанных товаров. */
showcasesAdminRouter.get('/:id', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const showcase = await prisma.showcase.findUnique({ where: { id: req.params.id } });
    if (!showcase) return res.status(404).json({ error: 'Витрина не найдена' });
    const links = await prisma.showcaseProduct.findMany({
      where: { showcaseId: showcase.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const collections = await prisma.showcaseCollection.findMany({
      where: { showcaseId: showcase.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    const outCollections: any[] = [];
    for (const c of collections) {
      outCollections.push({
        id: c.id,
        title: c.title,
        published: c.published,
        sortOrder: c.sortOrder,
        products: await linkedProducts(c.items),
      });
    }
    res.json({ ...showcase, products: await linkedProducts(links), collections: outCollections });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось получить витрину');
  }
});

const patchShowcase = z.object({
  type: z.enum(SHOWCASE_TYPES).optional(),
  title: title.optional(),
  description: optText(500),
  logoUrl: imageUrl.nullable().optional().or(z.literal('')),
  bannerUrl: imageUrl.nullable().optional().or(z.literal('')),
  bannerTitle: optText(120),
  bannerText: optText(1000),
  banners: bannersSchema.optional(),
  bigBanners: bannersSchema.optional(),
  videos: videosSchema.optional(),
  videoUrl: videoUrlSchema,
  published: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

showcasesAdminRouter.patch('/:id', async (req, res) => {
  const parsed = patchShowcase.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  try {
    const existing = await prisma.showcase.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Витрина не найдена' });
    const d = parsed.data;
    if (Object.values(d).every((v) => v === undefined)) return res.status(400).json({ error: 'Нет полей для изменения' });
    const data: any = {};
    if (d.type !== undefined) data.type = d.type;
    if (d.title !== undefined) data.title = d.title;
    if (d.published !== undefined) data.published = d.published;
    if (d.sortOrder !== undefined) data.sortOrder = d.sortOrder;
    for (const k of ['description', 'logoUrl', 'bannerUrl', 'bannerTitle', 'bannerText', 'videoUrl'] as const) {
      if (d[k] !== undefined) data[k] = blankToNull(d[k]);
    }
    if (d.banners !== undefined) data.banners = uniqueUrls(d.banners);
    if (d.bigBanners !== undefined) data.bigBanners = uniqueUrls(d.bigBanners);
    if (d.videos !== undefined) data.videos = d.videos;
    const row = await prisma.showcase.update({ where: { id: existing.id }, data });
    res.json(row);
  } catch (err: any) {
    fail(res, req, err, 'Не удалось сохранить витрину');
  }
});

/**
 * Удаление витрины. Требует явного подтверждения ?confirm=1 (интерфейс спрашивает
 * человека и добавляет его сам), иначе случайный DELETE ничего не сделает.
 * Удаляются витрина, её подборки и ссылки на товары — товары каталога остаются.
 */
showcasesAdminRouter.delete('/:id', async (req, res) => {
  if (req.query.confirm !== '1') {
    return res.status(400).json({ error: 'Удаление нужно подтвердить (?confirm=1)', code: 'CONFIRM_REQUIRED' });
  }
  try {
    const existing = await prisma.showcase.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Витрина не найдена' });
    await prisma.showcase.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось удалить витрину');
  }
});

// ---------------------------------------------------------------------------
// Товары витрины (каталог витрины)
// ---------------------------------------------------------------------------
showcasesAdminRouter.post('/:id/products', async (req, res) => {
  const parsed = z.object({ productId: productIdSchema }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  try {
    const showcase = await prisma.showcase.findUnique({ where: { id: req.params.id } });
    if (!showcase) return res.status(404).json({ error: 'Витрина не найдена' });
    const product = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
    if (!product) return res.status(404).json({ error: 'Товар не найден в каталоге' });
    if ((await prisma.showcaseProduct.count({ where: { showcaseId: showcase.id } })) >= MAX_PRODUCTS_PER_LIST) {
      return res.status(400).json({ error: `В витрине не может быть больше ${MAX_PRODUCTS_PER_LIST} товаров`, code: 'LIMIT_REACHED' });
    }
    const dup = await prisma.showcaseProduct.findFirst({ where: { showcaseId: showcase.id, productId: product.id } });
    if (dup) return res.status(409).json({ error: 'Этот товар уже есть в витрине', code: 'DUPLICATE' });
    const last = await prisma.showcaseProduct.findFirst({ where: { showcaseId: showcase.id }, orderBy: { sortOrder: 'desc' } });
    try {
      const link = await prisma.showcaseProduct.create({
        data: { showcaseId: showcase.id, productId: product.id, sortOrder: (last?.sortOrder ?? 0) + 1 },
      });
      return res.status(201).json({ ...link, product: productBrief(product) });
    } catch (err: any) {
      // Гонка двух одинаковых запросов: уникальный индекс не даст создать дубль.
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'Этот товар уже есть в витрине', code: 'DUPLICATE' });
      throw err;
    }
  } catch (err: any) {
    fail(res, req, err, 'Не удалось добавить товар в витрину');
  }
});

/** Список кодов из текста/массива: разделители — перевод строки, запятая, точка с запятой; повторы убираются. */
export function parseCodes(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw.flatMap((x) => x.split(/[\n\r,;]+/)) : raw.split(/[\n\r,;]+/);
  return Array.from(new Set(parts.map((x) => x.trim()).filter(Boolean)));
}
const MAX_BULK_CODES = 500;

/**
 * Массовое добавление: список артикулов (sku, артикул витрины, id, а также
 * артикулы площадок — только для поиска в админке) → привязка к витрине.
 * Каждый код обрабатывается отдельно: ненайденные/неоднозначные/уже добавленные
 * не мешают остальным. Порядок = порядок кодов в списке.
 */
showcasesAdminRouter.post('/:id/products/bulk', async (req, res) => {
  const parsed = z.object({ codes: z.union([z.string().max(200_000), z.array(z.string().max(200)).max(5000)]) }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const codes = parseCodes(parsed.data.codes);
  if (codes.length === 0) return res.status(400).json({ error: 'Список артикулов пуст' });
  if (codes.length > MAX_BULK_CODES) return res.status(400).json({ error: `За один раз можно добавить не больше ${MAX_BULK_CODES} артикулов`, code: 'TOO_MANY' });
  try {
    const showcase = await prisma.showcase.findUnique({ where: { id: req.params.id } });
    if (!showcase) return res.status(404).json({ error: 'Витрина не найдена' });

    const rows: any[] = await prisma.product.findMany({
      where: {
        OR: [
          { sku: { in: codes } }, { shopArticle: { in: codes } }, { id: { in: codes } },
          { kaspiSku: { in: codes } }, { ozonOfferId: { in: codes } }, { wbArticle: { in: codes } },
        ],
      },
    });
    const byCode = new Map<string, Map<string, any>>();
    for (const p of rows) {
      for (const v of [p.sku, p.shopArticle, p.id, p.kaspiSku, p.ozonOfferId, p.wbArticle]) {
        if (typeof v !== 'string' || !v) continue;
        if (!byCode.has(v)) byCode.set(v, new Map());
        byCode.get(v)!.set(p.id, p);
      }
    }

    const existing: any[] = await prisma.showcaseProduct.findMany({ where: { showcaseId: showcase.id } });
    const linked = new Set<string>(existing.map((l) => l.productId));
    let lastOrder = existing.reduce((m, l) => Math.max(m, l.sortOrder ?? 0), 0);

    const result = { added: [] as any[], alreadyIn: [] as string[], notFound: [] as string[], ambiguous: [] as string[], overLimit: [] as string[] };
    for (const code of codes) {
      const found = byCode.get(code);
      if (!found || found.size === 0) { result.notFound.push(code); continue; }
      if (found.size > 1) { result.ambiguous.push(code); continue; }
      const product = [...found.values()][0];
      if (linked.has(product.id)) { result.alreadyIn.push(code); continue; }
      if (linked.size >= MAX_PRODUCTS_PER_LIST) { result.overLimit.push(code); continue; }
      try {
        await prisma.showcaseProduct.create({ data: { showcaseId: showcase.id, productId: product.id, sortOrder: ++lastOrder } });
        linked.add(product.id);
        result.added.push({ code, product: productBrief(product) });
      } catch (err: any) {
        if (isUniqueViolation(err)) { linked.add(product.id); result.alreadyIn.push(code); continue; }
        throw err;
      }
    }
    res.json(result);
  } catch (err: any) {
    fail(res, req, err, 'Не удалось добавить товары в витрину');
  }
});

showcasesAdminRouter.put('/:id/products/order', async (req, res) => {
  const parsed = z.object({ productIds: z.array(productIdSchema).max(5000) }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const ids = parsed.data.productIds;
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'В списке есть повторы' });
  try {
    const showcase = await prisma.showcase.findUnique({ where: { id: req.params.id } });
    if (!showcase) return res.status(404).json({ error: 'Витрина не найдена' });
    const links = await prisma.showcaseProduct.findMany({ where: { showcaseId: showcase.id } });
    if (!checkFullOrder(res, links.map((l: any) => l.productId), ids, 'В списке есть товар, которого нет в этой витрине')) return;
    await prisma.$transaction(
      links.map((l: any) => prisma.showcaseProduct.update({ where: { id: l.id }, data: { sortOrder: ids.indexOf(l.productId) + 1 } })),
    );
    res.json({ ok: true });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось изменить порядок товаров');
  }
});

/** Убрать товар из витрины. Сам товар в каталоге не затрагивается. */
showcasesAdminRouter.delete('/:id/products/:productId', async (req, res) => {
  try {
    const link = await prisma.showcaseProduct.findFirst({
      where: { showcaseId: req.params.id, productId: req.params.productId },
    });
    if (!link) return res.status(404).json({ error: 'Товара нет в этой витрине' });
    await prisma.showcaseProduct.delete({ where: { id: link.id } });
    res.json({ ok: true });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось убрать товар из витрины');
  }
});

// ---------------------------------------------------------------------------
// Рекламные подборки («Новинки», «Хиты продаж», …)
// ---------------------------------------------------------------------------
showcasesAdminRouter.post('/:id/collections', async (req, res) => {
  const parsed = z.object({ title, published: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  try {
    const showcase = await prisma.showcase.findUnique({ where: { id: req.params.id } });
    if (!showcase) return res.status(404).json({ error: 'Витрина не найдена' });
    if ((await prisma.showcaseCollection.count({ where: { showcaseId: showcase.id } })) >= MAX_COLLECTIONS_PER_SHOWCASE) {
      return res.status(400).json({ error: `В витрине не может быть больше ${MAX_COLLECTIONS_PER_SHOWCASE} подборок`, code: 'LIMIT_REACHED' });
    }
    const last = await prisma.showcaseCollection.findFirst({ where: { showcaseId: showcase.id }, orderBy: { sortOrder: 'desc' } });
    const row = await prisma.showcaseCollection.create({
      data: {
        showcaseId: showcase.id,
        title: parsed.data.title,
        published: parsed.data.published ?? true,
        sortOrder: (last?.sortOrder ?? 0) + 1,
      },
    });
    res.status(201).json(row);
  } catch (err: any) {
    fail(res, req, err, 'Не удалось создать подборку');
  }
});

showcasesAdminRouter.put('/:id/collections/order', async (req, res) => {
  const parsed = idList.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const ids = parsed.data.ids;
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'В списке есть повторы' });
  try {
    const showcase = await prisma.showcase.findUnique({ where: { id: req.params.id } });
    if (!showcase) return res.status(404).json({ error: 'Витрина не найдена' });
    const rows = await prisma.showcaseCollection.findMany({ where: { showcaseId: showcase.id } });
    if (!checkFullOrder(res, rows.map((r: any) => r.id), ids, 'В списке есть неизвестная подборка')) return;
    await prisma.$transaction(ids.map((id, i) => prisma.showcaseCollection.update({ where: { id }, data: { sortOrder: i + 1 } })));
    res.json({ ok: true });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось изменить порядок подборок');
  }
});

showcasesAdminRouter.patch('/:id/collections/:cid', async (req, res) => {
  const parsed = z.object({ title: title.optional(), published: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  try {
    const existing = await prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Подборка не найдена' });
    const data: any = {};
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.published !== undefined) data.published = parsed.data.published;
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Нет полей для изменения' });
    res.json(await prisma.showcaseCollection.update({ where: { id: existing.id }, data }));
  } catch (err: any) {
    fail(res, req, err, 'Не удалось сохранить подборку');
  }
});

/** Удалить подборку (только подборку и её ссылки; товары каталога и товары витрины остаются). */
showcasesAdminRouter.delete('/:id/collections/:cid', async (req, res) => {
  try {
    const existing = await prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Подборка не найдена' });
    await prisma.showcaseCollection.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось удалить подборку');
  }
});

showcasesAdminRouter.post('/:id/collections/:cid/items', async (req, res) => {
  const parsed = z.object({ productId: productIdSchema }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  try {
    const collection = await prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
    if (!collection) return res.status(404).json({ error: 'Подборка не найдена' });
    const product = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
    if (!product) return res.status(404).json({ error: 'Товар не найден в каталоге' });
    if ((await prisma.showcaseCollectionItem.count({ where: { collectionId: collection.id } })) >= MAX_PRODUCTS_PER_LIST) {
      return res.status(400).json({ error: `В подборке не может быть больше ${MAX_PRODUCTS_PER_LIST} товаров`, code: 'LIMIT_REACHED' });
    }
    const dup = await prisma.showcaseCollectionItem.findFirst({ where: { collectionId: collection.id, productId: product.id } });
    if (dup) return res.status(409).json({ error: 'Этот товар уже есть в подборке', code: 'DUPLICATE' });
    const last = await prisma.showcaseCollectionItem.findFirst({ where: { collectionId: collection.id }, orderBy: { sortOrder: 'desc' } });
    try {
      const item = await prisma.showcaseCollectionItem.create({
        data: { collectionId: collection.id, productId: product.id, sortOrder: (last?.sortOrder ?? 0) + 1 },
      });
      return res.status(201).json({ ...item, product: productBrief(product) });
    } catch (err: any) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'Этот товар уже есть в подборке', code: 'DUPLICATE' });
      throw err;
    }
  } catch (err: any) {
    fail(res, req, err, 'Не удалось добавить товар в подборку');
  }
});

showcasesAdminRouter.put('/:id/collections/:cid/items/order', async (req, res) => {
  const parsed = z.object({ productIds: z.array(productIdSchema).max(5000) }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const ids = parsed.data.productIds;
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'В списке есть повторы' });
  try {
    const collection = await prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
    if (!collection) return res.status(404).json({ error: 'Подборка не найдена' });
    const items = await prisma.showcaseCollectionItem.findMany({ where: { collectionId: collection.id } });
    if (!checkFullOrder(res, items.map((it: any) => it.productId), ids, 'В списке есть товар, которого нет в этой подборке')) return;
    await prisma.$transaction(
      items.map((it: any) => prisma.showcaseCollectionItem.update({ where: { id: it.id }, data: { sortOrder: ids.indexOf(it.productId) + 1 } })),
    );
    res.json({ ok: true });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось изменить порядок товаров подборки');
  }
});

showcasesAdminRouter.delete('/:id/collections/:cid/items/:productId', async (req, res) => {
  try {
    const collection = await prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
    if (!collection) return res.status(404).json({ error: 'Подборка не найдена' });
    const item = await prisma.showcaseCollectionItem.findFirst({
      where: { collectionId: collection.id, productId: req.params.productId },
    });
    if (!item) return res.status(404).json({ error: 'Товара нет в этой подборке' });
    await prisma.showcaseCollectionItem.delete({ where: { id: item.id } });
    res.json({ ok: true });
  } catch (err: any) {
    fail(res, req, err, 'Не удалось убрать товар из подборки');
  }
});
