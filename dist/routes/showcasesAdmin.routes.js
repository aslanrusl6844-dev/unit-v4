"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_COLLECTIONS_PER_SHOWCASE = exports.MAX_PRODUCTS_PER_LIST = exports.TICKER_SIZE_MAX = exports.TICKER_SIZE_MIN = exports.showcasesAdminRouter = void 0;
exports.parseCodes = parseCodes;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const showcases_errors_1 = require("./showcases.errors");
const showcaseBanners_1 = require("../services/showcaseBanners");
const productExtras_1 = require("../services/productExtras");
const showcaseImport_1 = require("../services/showcaseImport");
const shopArticle_1 = require("../services/shopArticle");
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
exports.showcasesAdminRouter = (0, express_1.Router)();
const SHOWCASE_TYPES = ['brand', 'shop'];
const imageUrl = zod_1.z
    .string()
    .trim()
    .max(2000)
    .refine((v) => /^https?:\/\//i.test(v), 'Ссылка на картинку должна начинаться с http:// или https://');
const MAX_BANNERS = 10;
const bannersSchema = zod_1.z.array(imageUrl).max(MAX_BANNERS, `Не больше ${MAX_BANNERS} баннеров`);
const bigBannerItemsSchema = zod_1.z
    .array(zod_1.z.object({
    url: imageUrl,
    text: zod_1.z.string().max(600, 'Текст баннера — не длиннее 600 символов').nullable().optional(),
    textColor: zod_1.z.enum(showcaseBanners_1.BANNER_TEXT_COLORS).optional(),
    sizes: zod_1.z.array(zod_1.z.number().int().min(showcaseBanners_1.MIN_LINE_SIZE, 'Размер — от 1 до 100').max(showcaseBanners_1.MAX_LINE_SIZE, 'Размер — от 1 до 100')).max(30).optional(), // % по одному на строку text
}))
    .max(MAX_BANNERS, `Не больше ${MAX_BANNERS} баннеров`);
const videoUrlSchema = zod_1.z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Ссылка на видео должна начинаться с http:// или https://')
    .nullable()
    .optional();
/** Без повторов, порядок сохраняется. */
function uniqueUrls(list) {
    return Array.from(new Set(list));
}
/** Цвет строки: '#RRGGBB' (пусто/null — значение по умолчанию на стороне приложения). */
const hexColor = zod_1.z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет — в виде #RRGGBB').nullable().optional().or(zod_1.z.literal(''));
/** Размер шрифта бегущей строки, sp. */
exports.TICKER_SIZE_MIN = 8;
exports.TICKER_SIZE_MAX = 60;
const tickerSizeSchema = zod_1.z.number().int().min(exports.TICKER_SIZE_MIN, 'Размер — от 8 до 60').max(exports.TICKER_SIZE_MAX, 'Размер — от 8 до 60').nullable().optional();
const optText = (max) => zod_1.z.string().trim().max(max).nullable().optional();
const title = zod_1.z.string().trim().min(1, 'Название обязательно').max(120);
const productIdSchema = zod_1.z.string().trim().min(1).max(100);
const idList = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string().min(1).max(100)).max(1000) });
/** '' и null одинаково очищают необязательное поле. */
function blankToNull(v) {
    if (v === undefined)
        return undefined;
    if (v === null)
        return null;
    return v.trim() === '' ? null : v.trim();
}
function fail(res, req, err, what) {
    logger_1.logger.error({ err }, `[Showcases Admin] ${req.method} ${req.path} упал`);
    // Понятные ответы вместо общего 500: запись уже удалена (P2025), дубль (P2002), таблицы не созданы (P2021/P2022).
    const mapped = (0, showcases_errors_1.mapDbError)(err);
    if (mapped)
        return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: what, details: String(err?.message ?? err) });
}
/** Лимиты, чтобы страница витрины для приложения не раздувалась. */
exports.MAX_PRODUCTS_PER_LIST = 500;
exports.MAX_COLLECTIONS_PER_SHOWCASE = 30;
/**
 * Новый порядок должен быть ПОЛНЫМ списком текущих элементов: неизвестный id → 400,
 * неполный список (кто-то успел добавить/удалить) → 409 STALE_ORDER — иначе порядок
 * получился бы с повторяющимися номерами.
 */
function checkFullOrder(res, current, wanted, unknownMsg) {
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
function isUniqueViolation(err) {
    return err?.code === 'P2002';
}
function bad(res, parsed) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Неверные данные', details: parsed.error.flatten() });
}
/** Карточка товара для админки: только то, что нужно для выбора и показа в списке. */
function productBrief(p) {
    let image = null;
    try {
        const arr = p.images ? JSON.parse(p.images) : [];
        if (Array.isArray(arr) && typeof arr[0] === 'string')
            image = arr[0];
    }
    catch {
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
async function linkedProducts(links) {
    const ids = links.map((l) => l.productId);
    const rows = ids.length ? await prisma_1.prisma.product.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return links.map((l) => {
        const p = byId.get(l.productId);
        return p ? productBrief(p) : { id: l.productId, name: '(товар удалён из каталога)', missing: true };
    });
}
// ---------------------------------------------------------------------------
// Поиск товара каталога для добавления (по названию, id, sku, артикулу витрины)
// ВАЖНО: объявлен раньше '/:id', чтобы 'product-search' не принимался за id.
// ---------------------------------------------------------------------------
exports.showcasesAdminRouter.get('/product-search', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
        if (q.length < 1)
            return res.json([]);
        const rows = await prisma_1.prisma.product.findMany({
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
    }
    catch (err) {
        fail(res, req, err, 'Не удалось выполнить поиск товаров');
    }
});
// ---------------------------------------------------------------------------
// Витрины
// ---------------------------------------------------------------------------
exports.showcasesAdminRouter.get('/', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const rows = await prisma_1.prisma.showcase.findMany({
            where: q ? { title: { contains: q, mode: 'insensitive' } } : undefined,
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            include: { _count: { select: { products: true, collections: true } } },
        });
        res.json(rows);
    }
    catch (err) {
        fail(res, req, err, 'Не удалось получить витрины');
    }
});
const createShowcase = zod_1.z.object({
    type: zod_1.z.enum(SHOWCASE_TYPES),
    title,
    description: optText(500),
    logoUrl: imageUrl.nullable().optional().or(zod_1.z.literal('')),
    bannerUrl: imageUrl.nullable().optional().or(zod_1.z.literal('')),
    bannerTitle: optText(120),
    bannerText: optText(1000),
    banners: bannersSchema.optional(),
    bigBanners: bannersSchema.optional(),
    bigBannerItems: bigBannerItemsSchema.optional(), // {url, text, sizes, textColor} — имеет приоритет над bigBanners
    videos: productExtras_1.showcaseVideosSchema.optional(), // до 20
    videoUrl: videoUrlSchema,
    tickerText: optText(200),
    tickerBg: hexColor,
    tickerColor: hexColor,
    tickerSize: tickerSizeSchema,
    published: zod_1.z.boolean().optional(),
});
exports.showcasesAdminRouter.post('/', async (req, res) => {
    const parsed = createShowcase.safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    try {
        const d = parsed.data;
        const last = await prisma_1.prisma.showcase.findFirst({ orderBy: { sortOrder: 'desc' } });
        const row = await prisma_1.prisma.showcase.create({
            data: {
                type: d.type,
                title: d.title,
                description: blankToNull(d.description) ?? null,
                logoUrl: blankToNull(d.logoUrl) ?? null,
                bannerUrl: blankToNull(d.bannerUrl) ?? null,
                bannerTitle: blankToNull(d.bannerTitle) ?? null,
                bannerText: blankToNull(d.bannerText) ?? null,
                banners: uniqueUrls(d.banners ?? []),
                ...(0, showcaseBanners_1.resolveBigBannerWrite)({ items: d.bigBannerItems, urls: d.bigBanners ?? [] }),
                videos: d.videos ?? [],
                videoUrl: blankToNull(d.videoUrl) ?? null,
                tickerText: blankToNull(d.tickerText) ?? null,
                tickerBg: blankToNull(d.tickerBg)?.toUpperCase() ?? null,
                tickerColor: blankToNull(d.tickerColor)?.toUpperCase() ?? null,
                tickerSize: d.tickerSize ?? null,
                // Новая витрина по умолчанию скрыта: наполняем, потом публикуем.
                published: d.published ?? false,
                sortOrder: (last?.sortOrder ?? 0) + 1,
            },
        });
        res.status(201).json(row);
    }
    catch (err) {
        fail(res, req, err, 'Не удалось создать витрину');
    }
});
/** Порядок витрин: тело { ids: [...] } — новый порядок сверху вниз. */
exports.showcasesAdminRouter.put('/order', async (req, res) => {
    const parsed = idList.safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    const ids = parsed.data.ids;
    if (new Set(ids).size !== ids.length)
        return res.status(400).json({ error: 'В списке есть повторы' });
    try {
        const all = await prisma_1.prisma.showcase.findMany({});
        if (!checkFullOrder(res, all.map((r) => r.id), ids, 'В списке есть неизвестная витрина'))
            return;
        await prisma_1.prisma.$transaction(ids.map((id, i) => prisma_1.prisma.showcase.update({ where: { id }, data: { sortOrder: i + 1 } })));
        res.json({ ok: true });
    }
    catch (err) {
        fail(res, req, err, 'Не удалось изменить порядок витрин');
    }
});
/** Витрина целиком: поля, подборки (с товарами) и список привязанных товаров. */
exports.showcasesAdminRouter.get('/:id', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const showcase = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const links = await prisma_1.prisma.showcaseProduct.findMany({
            where: { showcaseId: showcase.id },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        const collections = await prisma_1.prisma.showcaseCollection.findMany({
            where: { showcaseId: showcase.id },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
        });
        const outCollections = [];
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
    }
    catch (err) {
        fail(res, req, err, 'Не удалось получить витрину');
    }
});
const patchShowcase = zod_1.z.object({
    type: zod_1.z.enum(SHOWCASE_TYPES).optional(),
    title: title.optional(),
    description: optText(500),
    logoUrl: imageUrl.nullable().optional().or(zod_1.z.literal('')),
    bannerUrl: imageUrl.nullable().optional().or(zod_1.z.literal('')),
    bannerTitle: optText(120),
    bannerText: optText(1000),
    banners: bannersSchema.optional(),
    bigBanners: bannersSchema.optional(),
    bigBannerItems: bigBannerItemsSchema.optional(), // {url, text, sizes, textColor} — имеет приоритет над bigBanners
    videos: productExtras_1.showcaseVideosSchema.optional(), // до 20
    videoUrl: videoUrlSchema,
    tickerText: optText(200),
    tickerBg: hexColor,
    tickerColor: hexColor,
    tickerSize: tickerSizeSchema,
    published: zod_1.z.boolean().optional(),
    sortOrder: zod_1.z.number().int().min(0).max(1_000_000).optional(),
});
exports.showcasesAdminRouter.patch('/:id', async (req, res) => {
    const parsed = patchShowcase.safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    try {
        const existing = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!existing)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const d = parsed.data;
        if (Object.values(d).every((v) => v === undefined))
            return res.status(400).json({ error: 'Нет полей для изменения' });
        const data = {};
        if (d.type !== undefined)
            data.type = d.type;
        if (d.title !== undefined)
            data.title = d.title;
        if (d.published !== undefined)
            data.published = d.published;
        if (d.sortOrder !== undefined)
            data.sortOrder = d.sortOrder;
        for (const k of ['description', 'logoUrl', 'bannerUrl', 'bannerTitle', 'bannerText', 'videoUrl']) {
            if (d[k] !== undefined)
                data[k] = blankToNull(d[k]);
        }
        if (d.tickerText !== undefined)
            data.tickerText = blankToNull(d.tickerText);
        for (const k of ['tickerBg', 'tickerColor']) {
            if (d[k] !== undefined)
                data[k] = blankToNull(d[k])?.toUpperCase() ?? null;
        }
        if (d.tickerSize !== undefined)
            data.tickerSize = d.tickerSize;
        if (d.banners !== undefined)
            data.banners = uniqueUrls(d.banners);
        Object.assign(data, (0, showcaseBanners_1.resolveBigBannerWrite)({ items: d.bigBannerItems, urls: d.bigBanners }, existing) ?? {});
        if (d.videos !== undefined)
            data.videos = d.videos;
        const row = await prisma_1.prisma.showcase.update({ where: { id: existing.id }, data });
        res.json(row);
    }
    catch (err) {
        fail(res, req, err, 'Не удалось сохранить витрину');
    }
});
/**
 * Удаление витрины. Требует явного подтверждения ?confirm=1 (интерфейс спрашивает
 * человека и добавляет его сам), иначе случайный DELETE ничего не сделает.
 * Удаляются витрина, её подборки и ссылки на товары — товары каталога остаются.
 */
exports.showcasesAdminRouter.delete('/:id', async (req, res) => {
    if (req.query.confirm !== '1') {
        return res.status(400).json({ error: 'Удаление нужно подтвердить (?confirm=1)', code: 'CONFIRM_REQUIRED' });
    }
    try {
        const existing = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!existing)
            return res.status(404).json({ error: 'Витрина не найдена' });
        await prisma_1.prisma.showcase.delete({ where: { id: existing.id } });
        res.json({ ok: true });
    }
    catch (err) {
        fail(res, req, err, 'Не удалось удалить витрину');
    }
});
// ---------------------------------------------------------------------------
// Товары витрины (каталог витрины)
// ---------------------------------------------------------------------------
exports.showcasesAdminRouter.post('/:id/products', async (req, res) => {
    const parsed = zod_1.z.object({ productId: productIdSchema }).safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    try {
        const showcase = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const product = await prisma_1.prisma.product.findUnique({ where: { id: parsed.data.productId } });
        if (!product)
            return res.status(404).json({ error: 'Товар не найден в каталоге' });
        if ((await prisma_1.prisma.showcaseProduct.count({ where: { showcaseId: showcase.id } })) >= exports.MAX_PRODUCTS_PER_LIST) {
            return res.status(400).json({ error: `В витрине не может быть больше ${exports.MAX_PRODUCTS_PER_LIST} товаров`, code: 'LIMIT_REACHED' });
        }
        const dup = await prisma_1.prisma.showcaseProduct.findFirst({ where: { showcaseId: showcase.id, productId: product.id } });
        if (dup)
            return res.status(409).json({ error: 'Этот товар уже есть в витрине', code: 'DUPLICATE' });
        const last = await prisma_1.prisma.showcaseProduct.findFirst({ where: { showcaseId: showcase.id }, orderBy: { sortOrder: 'desc' } });
        try {
            const link = await prisma_1.prisma.showcaseProduct.create({
                data: { showcaseId: showcase.id, productId: product.id, sortOrder: (last?.sortOrder ?? 0) + 1 },
            });
            return res.status(201).json({ ...link, product: productBrief(product) });
        }
        catch (err) {
            // Гонка двух одинаковых запросов: уникальный индекс не даст создать дубль.
            if (isUniqueViolation(err))
                return res.status(409).json({ error: 'Этот товар уже есть в витрине', code: 'DUPLICATE' });
            throw err;
        }
    }
    catch (err) {
        fail(res, req, err, 'Не удалось добавить товар в витрину');
    }
});
/** Список кодов из текста/массива: разделители — перевод строки, запятая, точка с запятой; повторы убираются. */
function parseCodes(raw) {
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
exports.showcasesAdminRouter.post('/:id/products/bulk', async (req, res) => {
    const parsed = zod_1.z.object({ codes: zod_1.z.union([zod_1.z.string().max(200_000), zod_1.z.array(zod_1.z.string().max(200)).max(5000)]) }).safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    const codes = parseCodes(parsed.data.codes);
    if (codes.length === 0)
        return res.status(400).json({ error: 'Список артикулов пуст' });
    if (codes.length > MAX_BULK_CODES)
        return res.status(400).json({ error: `За один раз можно добавить не больше ${MAX_BULK_CODES} артикулов`, code: 'TOO_MANY' });
    try {
        const showcase = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const rows = await prisma_1.prisma.product.findMany({
            where: {
                OR: [
                    { sku: { in: codes } }, { shopArticle: { in: codes } }, { id: { in: codes } },
                    { kaspiSku: { in: codes } }, { ozonOfferId: { in: codes } }, { wbArticle: { in: codes } },
                ],
            },
        });
        const byCode = new Map();
        for (const p of rows) {
            for (const v of [p.sku, p.shopArticle, p.id, p.kaspiSku, p.ozonOfferId, p.wbArticle]) {
                if (typeof v !== 'string' || !v)
                    continue;
                if (!byCode.has(v))
                    byCode.set(v, new Map());
                byCode.get(v).set(p.id, p);
            }
        }
        const existing = await prisma_1.prisma.showcaseProduct.findMany({ where: { showcaseId: showcase.id } });
        const linked = new Set(existing.map((l) => l.productId));
        let lastOrder = existing.reduce((m, l) => Math.max(m, l.sortOrder ?? 0), 0);
        const result = { added: [], alreadyIn: [], notFound: [], ambiguous: [], overLimit: [] };
        for (const code of codes) {
            const found = byCode.get(code);
            if (!found || found.size === 0) {
                result.notFound.push(code);
                continue;
            }
            if (found.size > 1) {
                result.ambiguous.push(code);
                continue;
            }
            const product = [...found.values()][0];
            if (linked.has(product.id)) {
                result.alreadyIn.push(code);
                continue;
            }
            if (linked.size >= exports.MAX_PRODUCTS_PER_LIST) {
                result.overLimit.push(code);
                continue;
            }
            try {
                await prisma_1.prisma.showcaseProduct.create({ data: { showcaseId: showcase.id, productId: product.id, sortOrder: ++lastOrder } });
                linked.add(product.id);
                result.added.push({ code, product: productBrief(product) });
            }
            catch (err) {
                if (isUniqueViolation(err)) {
                    linked.add(product.id);
                    result.alreadyIn.push(code);
                    continue;
                }
                throw err;
            }
        }
        res.json(result);
    }
    catch (err) {
        fail(res, req, err, 'Не удалось добавить товары в витрину');
    }
});
/**
 * Загрузка товаров из Excel (шаблон «Товары» — те же колонки, что у загрузки My Market).
 * Файл разбирает браузер и шлёт строки небольшими пачками (иначе таймаут serverless-функции).
 *  • Артикул (sku) найден → товар обновляется и добавляется в витрину (если его там нет);
 *  • не найден → создаётся новый товар («только для витрин») и добавляется в витрину.
 * Обязательные поля применяются всегда, необязательные — только если ячейка заполнена
 * (пустая ничего не стирает). Каждая строка обрабатывается отдельно: ошибка в одной не
 * мешает остальным. «В продаже» включается только для категории из списка разделов витрины.
 */
exports.showcasesAdminRouter.post('/:id/products/import', async (req, res) => {
    const parsed = zod_1.z.object({ rows: zod_1.z.array(zod_1.z.record(zod_1.z.any())).min(1).max(showcaseImport_1.MAX_IMPORT_BATCH) }).safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    try {
        const showcase = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const norm = parsed.data.rows.map((raw) => ({ raw, n: (0, showcaseImport_1.normalizeImportRow)(raw) }));
        const skus = Array.from(new Set(norm.flatMap((x) => (x.n.ok ? [x.n.row.sku] : []))));
        const found = skus.length ? await prisma_1.prisma.product.findMany({ where: { sku: { in: skus } } }) : [];
        const bySku = new Map(found.map((p) => [p.sku, p]));
        const links = await prisma_1.prisma.showcaseProduct.findMany({ where: { showcaseId: showcase.id } });
        const linked = new Set(links.map((l) => l.productId));
        let lastOrder = links.reduce((m, l) => Math.max(m, l.sortOrder ?? 0), 0);
        const out = {
            created: 0, updated: 0, linked: 0,
            errors: [],
            warnings: [],
        };
        const rowNoOf = (raw) => (typeof raw.row === 'number' ? raw.row : null);
        for (const { raw, n } of norm) {
            if (!n.ok) {
                out.errors.push({ row: rowNoOf(raw), sku: n.sku || String(raw.sku ?? ''), error: n.error });
                continue;
            }
            const d = n.row;
            try {
                const product = bySku.get(d.sku) ?? null;
                const needLink = !product || !linked.has(product.id);
                if (needLink && linked.size >= exports.MAX_PRODUCTS_PER_LIST) {
                    out.errors.push({ row: d.row, sku: d.sku, error: `в витрине уже ${exports.MAX_PRODUCTS_PER_LIST} товаров — лимит` });
                    continue;
                }
                const { active, downgraded } = (0, showcaseImport_1.resolveActive)(d.shopActive, d.category);
                for (const w of n.warnings)
                    out.warnings.push({ row: d.row, sku: d.sku, message: w });
                if (downgraded)
                    out.warnings.push({ row: d.row, sku: d.sku, message: `категория «${d.category}» не из списка разделов витрины — товар сохранён, но «В продаже» не включено` });
                let target = product;
                if (!product) {
                    const article = await (0, shopArticle_1.maybeGenerateShopArticle)({ currentShopArticle: null, effectivePrice: d.shopPrice, effectiveActive: active });
                    target = await prisma_1.prisma.product.create({
                        data: {
                            sku: d.sku, name: d.name, costPrice: 0,
                            category: d.category, subcategory: d.subcategory, type: d.type,
                            shopPrice: d.shopPrice, shopOldPrice: d.shopOldPrice, shopStock: d.shopStock,
                            shopDelivery: d.shopDelivery, shopActive: active,
                            description: d.description, composition: d.composition,
                            images: d.images ? JSON.stringify(d.images) : null,
                            videoUrl: d.videoUrl,
                            videos: d.videoUrl ? [d.videoUrl] : [],
                            showcaseOnly: true,
                            ...(article ? { shopArticle: article } : {}),
                        },
                    });
                    bySku.set(target.sku, target);
                    out.created += 1;
                }
                else {
                    const data = {
                        name: d.name, category: d.category, type: d.type,
                        shopPrice: d.shopPrice, shopStock: d.shopStock, shopActive: active,
                        ...(active ? { shopArchived: false } : {}),
                    };
                    if (d.subcategory)
                        data.subcategory = d.subcategory;
                    if (d.shopOldPrice != null)
                        data.shopOldPrice = d.shopOldPrice;
                    if (d.shopDelivery)
                        data.shopDelivery = d.shopDelivery;
                    if (d.description)
                        data.description = d.description;
                    if (d.composition)
                        data.composition = d.composition;
                    if (d.images)
                        data.images = JSON.stringify(d.images);
                    if (d.videoUrl) {
                        data.videoUrl = d.videoUrl;
                        data.videos = (0, showcaseImport_1.mergeVideos)(product.videos, d.videoUrl);
                    }
                    const article = await (0, shopArticle_1.maybeGenerateShopArticle)({ currentShopArticle: product.shopArticle ?? null, effectivePrice: d.shopPrice, effectiveActive: active });
                    if (article)
                        data.shopArticle = article;
                    target = await prisma_1.prisma.product.update({ where: { id: product.id }, data });
                    bySku.set(target.sku, target);
                    out.updated += 1;
                }
                if (needLink) {
                    try {
                        await prisma_1.prisma.showcaseProduct.create({ data: { showcaseId: showcase.id, productId: target.id, sortOrder: ++lastOrder } });
                        out.linked += 1;
                    }
                    catch (err) {
                        if (!isUniqueViolation(err))
                            throw err; // уже привязан параллельным запросом — не ошибка
                    }
                    linked.add(target.id);
                }
            }
            catch (err) {
                out.errors.push({ row: d.row, sku: d.sku, error: isUniqueViolation(err) ? 'такой артикул уже занят' : `не удалось сохранить: ${String(err?.message ?? err).slice(0, 200)}` });
            }
        }
        res.json(out);
    }
    catch (err) {
        fail(res, req, err, 'Не удалось загрузить товары из Excel');
    }
});
exports.showcasesAdminRouter.put('/:id/products/order', async (req, res) => {
    const parsed = zod_1.z.object({ productIds: zod_1.z.array(productIdSchema).max(5000) }).safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    const ids = parsed.data.productIds;
    if (new Set(ids).size !== ids.length)
        return res.status(400).json({ error: 'В списке есть повторы' });
    try {
        const showcase = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const links = await prisma_1.prisma.showcaseProduct.findMany({ where: { showcaseId: showcase.id } });
        if (!checkFullOrder(res, links.map((l) => l.productId), ids, 'В списке есть товар, которого нет в этой витрине'))
            return;
        await prisma_1.prisma.$transaction(links.map((l) => prisma_1.prisma.showcaseProduct.update({ where: { id: l.id }, data: { sortOrder: ids.indexOf(l.productId) + 1 } })));
        res.json({ ok: true });
    }
    catch (err) {
        fail(res, req, err, 'Не удалось изменить порядок товаров');
    }
});
/** Убрать товар из витрины. Сам товар в каталоге не затрагивается. */
exports.showcasesAdminRouter.delete('/:id/products/:productId', async (req, res) => {
    try {
        const link = await prisma_1.prisma.showcaseProduct.findFirst({
            where: { showcaseId: req.params.id, productId: req.params.productId },
        });
        if (!link)
            return res.status(404).json({ error: 'Товара нет в этой витрине' });
        await prisma_1.prisma.showcaseProduct.delete({ where: { id: link.id } });
        res.json({ ok: true });
    }
    catch (err) {
        fail(res, req, err, 'Не удалось убрать товар из витрины');
    }
});
// ---------------------------------------------------------------------------
// Рекламные подборки («Новинки», «Хиты продаж», …)
// ---------------------------------------------------------------------------
exports.showcasesAdminRouter.post('/:id/collections', async (req, res) => {
    const parsed = zod_1.z.object({ title, published: zod_1.z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    try {
        const showcase = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        if ((await prisma_1.prisma.showcaseCollection.count({ where: { showcaseId: showcase.id } })) >= exports.MAX_COLLECTIONS_PER_SHOWCASE) {
            return res.status(400).json({ error: `В витрине не может быть больше ${exports.MAX_COLLECTIONS_PER_SHOWCASE} подборок`, code: 'LIMIT_REACHED' });
        }
        const last = await prisma_1.prisma.showcaseCollection.findFirst({ where: { showcaseId: showcase.id }, orderBy: { sortOrder: 'desc' } });
        const row = await prisma_1.prisma.showcaseCollection.create({
            data: {
                showcaseId: showcase.id,
                title: parsed.data.title,
                published: parsed.data.published ?? true,
                sortOrder: (last?.sortOrder ?? 0) + 1,
            },
        });
        res.status(201).json(row);
    }
    catch (err) {
        fail(res, req, err, 'Не удалось создать подборку');
    }
});
exports.showcasesAdminRouter.put('/:id/collections/order', async (req, res) => {
    const parsed = idList.safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    const ids = parsed.data.ids;
    if (new Set(ids).size !== ids.length)
        return res.status(400).json({ error: 'В списке есть повторы' });
    try {
        const showcase = await prisma_1.prisma.showcase.findUnique({ where: { id: req.params.id } });
        if (!showcase)
            return res.status(404).json({ error: 'Витрина не найдена' });
        const rows = await prisma_1.prisma.showcaseCollection.findMany({ where: { showcaseId: showcase.id } });
        if (!checkFullOrder(res, rows.map((r) => r.id), ids, 'В списке есть неизвестная подборка'))
            return;
        await prisma_1.prisma.$transaction(ids.map((id, i) => prisma_1.prisma.showcaseCollection.update({ where: { id }, data: { sortOrder: i + 1 } })));
        res.json({ ok: true });
    }
    catch (err) {
        fail(res, req, err, 'Не удалось изменить порядок подборок');
    }
});
exports.showcasesAdminRouter.patch('/:id/collections/:cid', async (req, res) => {
    const parsed = zod_1.z.object({ title: title.optional(), published: zod_1.z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    try {
        const existing = await prisma_1.prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
        if (!existing)
            return res.status(404).json({ error: 'Подборка не найдена' });
        const data = {};
        if (parsed.data.title !== undefined)
            data.title = parsed.data.title;
        if (parsed.data.published !== undefined)
            data.published = parsed.data.published;
        if (Object.keys(data).length === 0)
            return res.status(400).json({ error: 'Нет полей для изменения' });
        res.json(await prisma_1.prisma.showcaseCollection.update({ where: { id: existing.id }, data }));
    }
    catch (err) {
        fail(res, req, err, 'Не удалось сохранить подборку');
    }
});
/** Удалить подборку (только подборку и её ссылки; товары каталога и товары витрины остаются). */
exports.showcasesAdminRouter.delete('/:id/collections/:cid', async (req, res) => {
    try {
        const existing = await prisma_1.prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
        if (!existing)
            return res.status(404).json({ error: 'Подборка не найдена' });
        await prisma_1.prisma.showcaseCollection.delete({ where: { id: existing.id } });
        res.json({ ok: true });
    }
    catch (err) {
        fail(res, req, err, 'Не удалось удалить подборку');
    }
});
exports.showcasesAdminRouter.post('/:id/collections/:cid/items', async (req, res) => {
    const parsed = zod_1.z.object({ productId: productIdSchema }).safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    try {
        const collection = await prisma_1.prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
        if (!collection)
            return res.status(404).json({ error: 'Подборка не найдена' });
        const product = await prisma_1.prisma.product.findUnique({ where: { id: parsed.data.productId } });
        if (!product)
            return res.status(404).json({ error: 'Товар не найден в каталоге' });
        if ((await prisma_1.prisma.showcaseCollectionItem.count({ where: { collectionId: collection.id } })) >= exports.MAX_PRODUCTS_PER_LIST) {
            return res.status(400).json({ error: `В подборке не может быть больше ${exports.MAX_PRODUCTS_PER_LIST} товаров`, code: 'LIMIT_REACHED' });
        }
        const dup = await prisma_1.prisma.showcaseCollectionItem.findFirst({ where: { collectionId: collection.id, productId: product.id } });
        if (dup)
            return res.status(409).json({ error: 'Этот товар уже есть в подборке', code: 'DUPLICATE' });
        const last = await prisma_1.prisma.showcaseCollectionItem.findFirst({ where: { collectionId: collection.id }, orderBy: { sortOrder: 'desc' } });
        try {
            const item = await prisma_1.prisma.showcaseCollectionItem.create({
                data: { collectionId: collection.id, productId: product.id, sortOrder: (last?.sortOrder ?? 0) + 1 },
            });
            return res.status(201).json({ ...item, product: productBrief(product) });
        }
        catch (err) {
            if (isUniqueViolation(err))
                return res.status(409).json({ error: 'Этот товар уже есть в подборке', code: 'DUPLICATE' });
            throw err;
        }
    }
    catch (err) {
        fail(res, req, err, 'Не удалось добавить товар в подборку');
    }
});
exports.showcasesAdminRouter.put('/:id/collections/:cid/items/order', async (req, res) => {
    const parsed = zod_1.z.object({ productIds: zod_1.z.array(productIdSchema).max(5000) }).safeParse(req.body);
    if (!parsed.success)
        return bad(res, parsed);
    const ids = parsed.data.productIds;
    if (new Set(ids).size !== ids.length)
        return res.status(400).json({ error: 'В списке есть повторы' });
    try {
        const collection = await prisma_1.prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
        if (!collection)
            return res.status(404).json({ error: 'Подборка не найдена' });
        const items = await prisma_1.prisma.showcaseCollectionItem.findMany({ where: { collectionId: collection.id } });
        if (!checkFullOrder(res, items.map((it) => it.productId), ids, 'В списке есть товар, которого нет в этой подборке'))
            return;
        await prisma_1.prisma.$transaction(items.map((it) => prisma_1.prisma.showcaseCollectionItem.update({ where: { id: it.id }, data: { sortOrder: ids.indexOf(it.productId) + 1 } })));
        res.json({ ok: true });
    }
    catch (err) {
        fail(res, req, err, 'Не удалось изменить порядок товаров подборки');
    }
});
exports.showcasesAdminRouter.delete('/:id/collections/:cid/items/:productId', async (req, res) => {
    try {
        const collection = await prisma_1.prisma.showcaseCollection.findFirst({ where: { id: req.params.cid, showcaseId: req.params.id } });
        if (!collection)
            return res.status(404).json({ error: 'Подборка не найдена' });
        const item = await prisma_1.prisma.showcaseCollectionItem.findFirst({
            where: { collectionId: collection.id, productId: req.params.productId },
        });
        if (!item)
            return res.status(404).json({ error: 'Товара нет в этой подборке' });
        await prisma_1.prisma.showcaseCollectionItem.delete({ where: { id: item.id } });
        res.json({ ok: true });
    }
    catch (err) {
        fail(res, req, err, 'Не удалось убрать товар из подборки');
    }
});
//# sourceMappingURL=showcasesAdmin.routes.js.map