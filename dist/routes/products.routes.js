"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const kaspi_categories_1 = require("../integrations/kaspi.categories");
const shopRules_1 = require("../config/shopRules");
const shopArticle_1 = require("../services/shopArticle");
const shopCategories_1 = require("../config/shopCategories");
const productExtras_1 = require("../services/productExtras");
exports.productsRouter = (0, express_1.Router)();
exports.productsRouter.get('/', async (_req, res) => {
    const startedAt = Date.now();
    try {
        const products = await prisma_1.prisma.product.findMany({ orderBy: { updatedAt: 'desc' } });
        logger_1.logger.info(`[DB] GET /products — ${Date.now() - startedAt}мс, найдено: ${products.length}`);
        res.json(products);
    }
    catch (err) {
        logger_1.logger.error({ err }, `[DB] GET /products упал через ${Date.now() - startedAt}мс`);
        res.status(500).json({ error: 'Ошибка получения товаров', details: String(err?.message ?? err) });
    }
});
// ПОЛНЫЙ список категорий Kaspi со ставками — и верхнего уровня, и точных
// leaf-исключений (см. getAllKaspiCategoriesWithRates) — для выпадающего
// списка с поиском в разделе «Товары». Раньше отдавались только 20 верхних
// разделов — теперь плюс ~40 точных подкатегорий, тот же источник, что
// реально используется при расчёте комиссии.
exports.productsRouter.get('/kaspi-categories', (_req, res) => {
    res.json((0, kaspi_categories_1.getAllKaspiCategoriesWithRates)());
});
// ВАЖНО: shopArticle сюда НЕ добавлять как принимаемое клиентом поле — оно
// только генерируется сервером (services/shopArticle.ts), карточка и Excel
// не должны иметь возможность его вписать (в том числе значение вида
// ozon-.../wb-.../kaspi-...). Zod и так отбрасывает неизвестные ключи —
// пока shopArticle не объявлен ниже, прислать его снаружи невозможно.
const productSchema = zod_1.z.object({
    sku: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    costPrice: zod_1.z.number().nonnegative(),
    packagingCost: zod_1.z.number().nonnegative().default(0),
    weightKg: zod_1.z.number().positive().default(0.5),
    kaspiSku: zod_1.z.string().optional().nullable(),
    kaspiTopCategory: zod_1.z.string().optional().nullable(),
    kaspiLeafCategory: zod_1.z.string().optional().nullable(),
    ozonOfferId: zod_1.z.string().optional().nullable(),
    ozonSku: zod_1.z.number().optional().nullable(),
    wbArticle: zod_1.z.string().optional().nullable(),
    wbNmId: zod_1.z.number().optional().nullable(),
    active: zod_1.z.boolean().optional().default(true),
    // Цена продажи по каждой площадке — можно вписать вручную прямо в
    // каталоге (например, для ещё не проданного товара, чтобы сразу увидеть
    // прогноз прибыли), не только автоматически из факта продажи/API.
    kaspiReferencePrice: zod_1.z.number().positive().optional().nullable(),
    ozonReferencePrice: zod_1.z.number().positive().optional().nullable(),
    wbReferencePrice: zod_1.z.number().positive().optional().nullable(),
    // Объём товара в литрах — для расчёта логистики WB по литрам (см.
    // src/integrations/wb.logistics.ts). Если не указан, по умолчанию 1 литр.
    wbVolumeLiters: zod_1.z.number().positive().optional().nullable(),
    // --- Витрина приложения My Market (канал APP) ---
    shopActive: zod_1.z.boolean().optional(),
    shopArchived: zod_1.z.boolean().optional(),
    descriptionSource: zod_1.z.string().nullable().optional(),
    compositionSource: zod_1.z.string().nullable().optional(),
    categorySource: zod_1.z.string().nullable().optional(),
    shopPrice: zod_1.z.number().nonnegative().optional().nullable(),
    shopOldPrice: zod_1.z.number().nonnegative().optional().nullable(),
    shopStock: zod_1.z.number().int().nonnegative().optional(),
    category: zod_1.z.string().optional().nullable(),
    subcategory: zod_1.z.string().optional().nullable(),
    type: zod_1.z.string().optional().nullable(),
    description: zod_1.z.string().optional().nullable(),
    composition: zod_1.z.string().optional().nullable(),
    images: zod_1.z.string().optional().nullable(), // JSON-массив URL строкой
    shopDelivery: zod_1.z.string().optional().nullable(),
    shopVideo: zod_1.z.string().optional().nullable(),
    videoUrl: zod_1.z.string().optional().nullable(),
    // Массивы от админки; в БД уходят JSON-строкой (см. services/productExtras.ts).
    showcaseOnly: zod_1.z.boolean().optional(), // товар создан внутри витрины — в общий каталог My Market не попадает
    quantityVariants: productExtras_1.quantityVariantsSchema.optional().nullable(),
    details: productExtras_1.detailsSchema.optional().nullable(),
    videos: productExtras_1.videosSchema.optional(), // до 3 видео товара (URL)
    shopCost: zod_1.z.number().nonnegative().optional().nullable(),
    // Подписка «Вау»: % скидки для подписчиков (1..30), null — без метки «Вау».
    wowPercent: zod_1.z.number().int().min(1).max(30).optional().nullable(),
    wowUntil: zod_1.z.coerce.date().optional().nullable(),
    banner: zod_1.z.boolean().optional(),
    bannerTitle: zod_1.z.string().optional().nullable(),
    bannerSubtitle: zod_1.z.string().optional().nullable(),
});
exports.productsRouter.post('/', async (req, res) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const data = { ...parsed.data };
    if (parsed.data.quantityVariants !== undefined)
        data.quantityVariants = (0, productExtras_1.serializeJsonArray)(parsed.data.quantityVariants);
    if (parsed.data.details !== undefined)
        data.details = parsed.data.details ?? [];
    // Та же защита, что и в PUT: нельзя СРАЗУ создать товар «В продаже» без
    // корректной category/цены — на практике карточка всегда создаёт новый
    // товар с shopActive=false, но проверяем и здесь, а не только в PUT.
    if (data.shopActive === true) {
        if (!data.category) {
            return res.status(400).json({ error: 'Нельзя включить «В продаже» без заполненной category' });
        }
        if (!(0, shopCategories_1.isValidShopCategory)(data.category)) {
            return res.status(400).json({ error: `Нельзя включить «В продаже»: категория «${data.category}» не из списка разделов витрины` });
        }
        if (shopRules_1.SHOP_TYPE_REQUIRED_FOR_SALE && !data.type) {
            return res.status(400).json({ error: 'Нельзя включить «В продаже» без заполненных category и type' });
        }
        if (data.shopPrice == null) {
            return res.status(400).json({ error: 'Нельзя включить «В продаже» без цены на витрине (shopPrice)' });
        }
    }
    // Та же логика, что и при сохранении карточки (services/shopArticle.ts) —
    // если новый товар создаётся сразу с ценой или сразу «В продаже», артикул
    // витрины генерируется здесь же, не дожидаясь первого PUT.
    if (data.shopPrice !== undefined || data.shopActive === true) {
        const article = await (0, shopArticle_1.maybeGenerateShopArticle)({
            currentShopArticle: null, // новый товар — артикула ещё точно нет
            effectivePrice: data.shopPrice,
            effectiveActive: data.shopActive,
        });
        if (article)
            data.shopArticle = article;
    }
    const startedAt = Date.now();
    try {
        const product = await prisma_1.prisma.product.create({ data });
        logger_1.logger.info(`[DB] POST /products — ${Date.now() - startedAt}мс, создан: ${product.id}`);
        res.status(201).json(product);
    }
    catch (err) {
        logger_1.logger.error({ err }, `[DB] POST /products упал через ${Date.now() - startedAt}мс`);
        // P2002 = нарушение уникальности (например, такой SKU/kaspiSku уже есть) — частая, понятная причина.
        if (err?.code === 'P2002') {
            return res.status(409).json({
                error: 'Товар с таким SKU, артикулом Kaspi, Ozon или WB уже существует',
                details: String(err?.meta?.target ?? ''),
            });
        }
        res.status(500).json({ error: 'Ошибка создания товара', details: String(err?.message ?? err) });
    }
});
/**
 * Массовая загрузка товаров (Excel/CSV) — файл парсится в браузере
 * (см. public/dashboard.js), сюда приходит уже готовый JSON-массив.
 * Сервер сам режет присланное на партии по 200 строк на транзакцию —
 * так безопаснее для serverless-таймаутов, даже если с фронта вдруг
 * прилетит большой массив целиком.
 */
const bulkRowSchema = zod_1.z.object({
    sku: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    kaspiSku: zod_1.z.string().optional().nullable(),
    costPrice: zod_1.z.number().nonnegative().default(0),
    kaspiTopCategory: zod_1.z.string().optional().nullable(),
    // Цена витрины из файла (например, колонка "price" в выгрузке Kaspi) —
    // используется как referencePrice для прогноза юнит-экономики Kaspi,
    // если у товара ещё нет цены из реальной продажи.
    kaspiReferencePrice: zod_1.z.number().positive().optional().nullable(),
});
const BULK_CHUNK_SIZE = 200;
exports.productsRouter.post('/bulk-upsert', async (req, res) => {
    const bodySchema = zod_1.z.object({ products: zod_1.z.array(bulkRowSchema).min(1).max(2000) });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Неверный формат данных', details: parsed.error.flatten() });
    }
    const rows = parsed.data.products;
    let created = 0;
    let updated = 0;
    const errors = [];
    for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + BULK_CHUNK_SIZE);
        try {
            const results = await prisma_1.prisma.$transaction(chunk.map((row) => prisma_1.prisma.product.upsert({
                where: { sku: row.sku },
                update: {
                    name: row.name,
                    costPrice: row.costPrice,
                    ...(row.kaspiSku ? { kaspiSku: row.kaspiSku } : {}),
                    ...(row.kaspiTopCategory ? { kaspiTopCategory: row.kaspiTopCategory } : {}),
                    ...(row.kaspiReferencePrice ? { kaspiReferencePrice: row.kaspiReferencePrice, kaspiReferencePriceUpdatedAt: new Date() } : {}),
                },
                create: {
                    sku: row.sku,
                    name: row.name,
                    costPrice: row.costPrice,
                    kaspiSku: row.kaspiSku || null,
                    kaspiTopCategory: row.kaspiTopCategory || null,
                    ...(row.kaspiReferencePrice ? { kaspiReferencePrice: row.kaspiReferencePrice, kaspiReferencePriceUpdatedAt: new Date() } : {}),
                },
            })));
            // upsert не говорит напрямую "создан или обновлён" — считаем по createdAt≈updatedAt.
            results.forEach((r) => {
                if (Math.abs(r.createdAt.getTime() - r.updatedAt.getTime()) < 1000)
                    created += 1;
                else
                    updated += 1;
            });
        }
        catch (err) {
            logger_1.logger.error({ err }, `[Bulk] Ошибка в партии строк ${i}-${i + chunk.length}`);
            // Транзакция всей партии упала (например, дубликат kaspiSku внутри
            // самой партии) — пробуем построчно, чтобы не терять весь пакет из-за одной плохой строки.
            for (const row of chunk) {
                try {
                    const existing = await prisma_1.prisma.product.findUnique({ where: { sku: row.sku } });
                    if (existing) {
                        await prisma_1.prisma.product.update({
                            where: { sku: row.sku },
                            data: {
                                name: row.name,
                                costPrice: row.costPrice,
                                ...(row.kaspiSku ? { kaspiSku: row.kaspiSku } : {}),
                                ...(row.kaspiTopCategory ? { kaspiTopCategory: row.kaspiTopCategory } : {}),
                                ...(row.kaspiReferencePrice ? { kaspiReferencePrice: row.kaspiReferencePrice, kaspiReferencePriceUpdatedAt: new Date() } : {}),
                            },
                        });
                        updated += 1;
                    }
                    else {
                        await prisma_1.prisma.product.create({
                            data: {
                                sku: row.sku,
                                name: row.name,
                                costPrice: row.costPrice,
                                kaspiSku: row.kaspiSku || null,
                                kaspiTopCategory: row.kaspiTopCategory || null,
                                ...(row.kaspiReferencePrice ? { kaspiReferencePrice: row.kaspiReferencePrice, kaspiReferencePriceUpdatedAt: new Date() } : {}),
                            },
                        });
                        created += 1;
                    }
                }
                catch (rowErr) {
                    errors.push(`${row.sku}: ${String(rowErr?.message ?? rowErr).slice(0, 150)}`);
                }
            }
        }
    }
    logger_1.logger.info(`[Bulk] Загрузка завершена: создано ${created}, обновлено ${updated}, ошибок ${errors.length}`);
    res.json({ ok: true, total: rows.length, created, updated, errors: errors.slice(0, 50) });
});
/**
 * Массово проставить себестоимость — самый частый сценарий: после
 * автосоздания товаров из заказов у десятков позиций себестоимость 0,
 * и по одной их вручную не находишься. Обновляет ВСЕ товары с нулевой
 * себестоимостью на одно и то же значение одним запросом.
 */
exports.productsRouter.post('/bulk-set-cost-price', async (req, res) => {
    const schema = zod_1.z.object({ costPrice: zod_1.z.number().nonnegative() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    try {
        const result = await prisma_1.prisma.product.updateMany({
            where: { costPrice: 0 },
            data: { costPrice: parsed.data.costPrice },
        });
        res.json({ ok: true, updated: result.count });
    }
    catch (err) {
        res.status(500).json({ error: 'Не удалось обновить себестоимость', details: String(err?.message ?? err) });
    }
});
/** Массовое удаление — для очистки мусорных карточек (например,
 *  "Товар без названия", появившихся из-за проблем при синхронизации). */
exports.productsRouter.post('/bulk-delete', async (req, res) => {
    const schema = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string()).min(1).max(2000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    try {
        const result = await prisma_1.prisma.product.deleteMany({ where: { id: { in: parsed.data.ids } } });
        res.json({ ok: true, deleted: result.count });
    }
    catch (err) {
        res.status(500).json({ error: 'Не удалось удалить товары', details: String(err?.message ?? err) });
    }
});
/** Массовая архивация (снятие с продажи внутри сервиса — active=false),
 *  без физического удаления записей и истории заказов по ним. */
exports.productsRouter.post('/bulk-archive', async (req, res) => {
    const schema = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string()).min(1).max(2000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    try {
        const result = await prisma_1.prisma.product.updateMany({ where: { id: { in: parsed.data.ids } }, data: { active: false } });
        res.json({ ok: true, archived: result.count });
    }
    catch (err) {
        res.status(500).json({ error: 'Не удалось архивировать товары', details: String(err?.message ?? err) });
    }
});
/**
 * Массовое проставление категории Kaspi выбранным товарам — для очистки
 * пачки "нет категории" за один раз. Категория должна ТОЧНО совпадать с
 * одной из категорий в справочнике (getAllKaspiCategoriesWithRates) — не
 * принимаем произвольный текст, иначе комиссия потом посчитается по
 * безопасному дефолту, а не по реальной ставке (то же самое "не
 * выдумывать проценты", что и везде в проекте). Сервер сам решает, в
 * kaspiTopCategory или kaspiLeafCategory положить значение — по уровню
 * найденной категории, не полагаясь на то, что прислал фронтенд.
 */
exports.productsRouter.post('/bulk-set-category', async (req, res) => {
    const schema = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string()).min(1).max(2000), categoryName: zod_1.z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.flatten() });
    const option = (0, kaspi_categories_1.getAllKaspiCategoriesWithRates)().find((c) => c.name === parsed.data.categoryName);
    if (!option) {
        return res.status(400).json({ error: `Категория «${parsed.data.categoryName}» не найдена в справочнике Kaspi — выберите точное совпадение из списка` });
    }
    try {
        const data = option.level === 'leaf' ? { kaspiLeafCategory: option.name } : { kaspiTopCategory: option.name };
        const result = await prisma_1.prisma.product.updateMany({ where: { id: { in: parsed.data.ids } }, data });
        res.json({ ok: true, updated: result.count });
    }
    catch (err) {
        res.status(500).json({ error: 'Не удалось проставить категорию', details: String(err?.message ?? err) });
    }
});
exports.productsRouter.put('/:id', async (req, res) => {
    const parsed = productSchema.partial().safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    // Если цену по площадке вводят вручную — отмечаем её "свежей" (сейчас),
    // чтобы синхронизация заказов её не перезаписала более старой датой, но
    // реальная новая продажа всё равно сможет обновить эту цену дальше.
    const data = { ...parsed.data };
    if (parsed.data.quantityVariants !== undefined)
        data.quantityVariants = (0, productExtras_1.serializeJsonArray)(parsed.data.quantityVariants);
    if (parsed.data.details !== undefined)
        data.details = parsed.data.details ?? [];
    if (data.kaspiReferencePrice != null)
        data.kaspiReferencePriceUpdatedAt = new Date();
    if (data.ozonReferencePrice != null)
        data.ozonReferencePriceUpdatedAt = new Date();
    if (data.wbReferencePrice != null)
        data.wbReferencePriceUpdatedAt = new Date();
    // My Market (APP): нельзя включить "В продаже" (shopActive=true) без
    // category И type — карточка без них не может корректно попасть в
    // категории приложения. Проверяем ОБЕ версии (то, что уже сохранено, и
    // то, что пришло в этом же запросе), чтобы не заблокировать случай
    // "включаю И одновременно проставляю категорию одним запросом".
    // Включили «В продаже» — значит товар возвращается из архива витрины
    // (архивный товар в продаже быть не может), если архив явно не задан.
    if (data.shopActive === true && data.shopArchived === undefined)
        data.shopArchived = false;
    // Ручная правка описания/состава/категории/типа в карточке снимает пометку
    // «это записал синк Ozon» — такое поле синк больше не перезаписывает.
    // Сравниваем с тем, что уже сохранено: карточка шлёт все поля целиком, и
    // «сохранил без изменений» источник не сбрасывает.
    if (data.description !== undefined || data.composition !== undefined || data.category !== undefined || data.type !== undefined) {
        const cur = await prisma_1.prisma.product.findUnique({
            where: { id: req.params.id },
            select: { description: true, composition: true, category: true, type: true },
        });
        if (cur) {
            const differs = (a, b) => (a || null) !== (b || null);
            if (data.description !== undefined && differs(data.description, cur.description))
                data.descriptionSource = null;
            if (data.composition !== undefined && differs(data.composition, cur.composition))
                data.compositionSource = null;
            if ((data.category !== undefined && differs(data.category, cur.category)) || (data.type !== undefined && differs(data.type, cur.type)))
                data.categorySource = null;
        }
    }
    if (data.shopActive === true) {
        const existing = await prisma_1.prisma.product.findUnique({ where: { id: req.params.id } });
        const category = data.category !== undefined ? data.category : existing?.category;
        const type = data.type !== undefined ? data.type : existing?.type;
        const shopPrice = data.shopPrice !== undefined ? data.shopPrice : existing?.shopPrice;
        if (!category) {
            return res.status(400).json({ error: 'Нельзя включить «В продаже» без заполненной category' });
        }
        // Жёсткий список разделов витрины (src/config/shopCategories.ts) — старое
        // значение вне списка («украшение», «Кухня», нижний регистр и т.п.) не
        // угадывается и не пропускается, продавец должен явно выбрать раздел.
        if (!(0, shopCategories_1.isValidShopCategory)(category)) {
            return res.status(400).json({ error: `Нельзя включить «В продаже»: категория «${category}» не из списка разделов витрины` });
        }
        // type для продажи обязателен только при SHOP_TYPE_REQUIRED_FOR_SALE (config/shopRules.ts).
        if (shopRules_1.SHOP_TYPE_REQUIRED_FOR_SALE && !type) {
            return res.status(400).json({ error: 'Нельзя включить «В продаже» без заполненных category и type' });
        }
        // Цену Ozon/Kaspi/WB на витрину не подставляем — её задают вручную.
        if (shopPrice == null) {
            return res.status(400).json({ error: 'Нельзя включить «В продаже» без цены на витрине (shopPrice)' });
        }
    }
    // Артикул витрины — генерируется один раз (см. services/shopArticle.ts):
    // при первом сохранении, где в итоге есть цена, либо при включении «В
    // продаже», и только если ещё не сгенерирован. Дальше не перегенерируется.
    if (data.shopPrice !== undefined || data.shopActive === true) {
        const cur = await prisma_1.prisma.product.findUnique({ where: { id: req.params.id }, select: { shopArticle: true, shopPrice: true } });
        if (cur) {
            const article = await (0, shopArticle_1.maybeGenerateShopArticle)({
                currentShopArticle: cur.shopArticle,
                effectivePrice: data.shopPrice !== undefined ? data.shopPrice : cur.shopPrice,
                effectiveActive: data.shopActive,
            });
            if (article)
                data.shopArticle = article;
        }
    }
    try {
        const product = await prisma_1.prisma.product.update({ where: { id: req.params.id }, data });
        res.json(product);
    }
    catch (err) {
        if (err?.code === 'P2025')
            return res.status(404).json({ error: 'Товар не найден' });
        logger_1.logger.error({ err }, `[DB] PUT /products/${req.params.id} упал`);
        res.status(500).json({ error: 'Не удалось обновить товар', details: String(err?.message ?? err) });
    }
});
exports.productsRouter.delete('/:id', async (req, res) => {
    try {
        await prisma_1.prisma.product.delete({ where: { id: req.params.id } });
        res.status(204).send();
    }
    catch (err) {
        if (err?.code === 'P2025')
            return res.status(404).json({ error: 'Товар не найден' });
        logger_1.logger.error({ err }, `[DB] DELETE /products/${req.params.id} упал`);
        res.status(500).json({ error: 'Не удалось удалить товар', details: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=products.routes.js.map