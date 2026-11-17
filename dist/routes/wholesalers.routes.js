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
exports.sameCity = exports.wholesalersRouter = void 0;
exports.parseAppItems = parseAppItems;
const express_1 = require("express");
const zod_1 = require("zod");
const jszip_1 = __importDefault(require("jszip"));
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const timezone_1 = require("../utils/timezone");
const dayjs_1 = __importDefault(require("dayjs"));
/**
 * Генератор накладных (pdfkit, bwip-js, шрифты) подключается ЛЕНИВО — только в
 * момент скачивания накладной. Список оптовиков, добавление и перенос товара
 * от него не зависят: даже если файл сервиса или его библиотеки недоступны,
 * функция стартует, а ошибка будет только у самой накладной (её ловят
 * обработчики ниже и отдают понятное сообщение).
 */
async function generateWholesalerWaybillPdf(input) {
    const mod = await Promise.resolve().then(() => __importStar(require('../services/wholesalerWaybill.service')));
    return mod.generateWholesalerWaybillPdf(input);
}
/**
 * Оптовики раздела «Товары» (Kaspi / Ozon / WB): полки товаров по оптовикам.
 * Модель Product, синхронизация и расчёт комиссии/логистики/налога НЕ
 * затрагиваются: привязка «товар -> оптовик» живёт в своей таблице
 * WholesalerProduct, а товар без записи в ней — на полке «Без оптовика».
 */
exports.wholesalersRouter = (0, express_1.Router)();
// ---------------------------------------------------------------------------
// Закупки у оптовиков: продавец записывает, сколько потратил на закупку (общая сумма
// или по оптовику). Только учёт — на себестоимость/прибыль не влияет.
// ---------------------------------------------------------------------------
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const purchaseSchema = zod_1.z.object({
    amount: zod_1.z.number().positive().max(1_000_000_000),
    wholesalerId: zod_1.z.string().min(1).nullable().optional(),
    note: zod_1.z.string().max(300).nullable().optional(),
    date: zod_1.z.string().regex(YMD).optional(),
});
/** Закупки за период { from, to } (ГГГГ-ММ-ДД) + итоги: за период, за всё время, по оптовикам за период. */
exports.wholesalersRouter.get('/purchases', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const from = YMD.test(String(req.query.from ?? '')) ? String(req.query.from) : null;
        const to = YMD.test(String(req.query.to ?? '')) ? String(req.query.to) : null;
        const where = from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
        const [items, allAgg] = await Promise.all([
            prisma_1.prisma.wholesalerPurchase.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000 }),
            prisma_1.prisma.wholesalerPurchase.aggregate({ _sum: { amount: true } }),
        ]);
        const byWholesaler = {};
        let totalPeriod = 0;
        for (const it of items) {
            totalPeriod += it.amount;
            const k = it.wholesalerId ?? '__general__';
            byWholesaler[k] = (byWholesaler[k] ?? 0) + it.amount;
        }
        res.json({ items, totalPeriod: Math.round(totalPeriod), totalAll: Math.round(allAgg._sum.amount ?? 0), byWholesaler });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Закупки] список');
        res.status(500).json({ error: 'Не удалось получить закупки', details: String(err?.message ?? err) });
    }
});
exports.wholesalersRouter.post('/purchases', async (req, res) => {
    const parsed = purchaseSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Укажите сумму больше 0' });
    try {
        const d = parsed.data;
        const item = await prisma_1.prisma.wholesalerPurchase.create({
            data: {
                amount: Math.round(d.amount),
                wholesalerId: d.wholesalerId || null,
                note: d.note?.trim() || null,
                date: d.date ?? (0, timezone_1.almatyNow)().format('YYYY-MM-DD'),
            },
        });
        res.status(201).json(item);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Закупки] добавление');
        res.status(500).json({ error: 'Не удалось добавить закупку', details: String(err?.message ?? err) });
    }
});
exports.wholesalersRouter.put('/purchases/:pid', async (req, res) => {
    const parsed = purchaseSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Укажите сумму больше 0' });
    try {
        const d = parsed.data;
        const item = await prisma_1.prisma.wholesalerPurchase.update({
            where: { id: req.params.pid },
            data: {
                amount: Math.round(d.amount),
                wholesalerId: d.wholesalerId || null,
                note: d.note?.trim() || null,
                ...(d.date ? { date: d.date } : {}),
            },
        });
        res.json(item);
    }
    catch (err) {
        if (err?.code === 'P2025')
            return res.status(404).json({ error: 'Запись не найдена' });
        logger_1.logger.error({ err }, '[Закупки] изменение');
        res.status(500).json({ error: 'Не удалось изменить закупку', details: String(err?.message ?? err) });
    }
});
exports.wholesalersRouter.delete('/purchases/:pid', async (req, res) => {
    try {
        await prisma_1.prisma.wholesalerPurchase.delete({ where: { id: req.params.pid } });
        res.json({ ok: true });
    }
    catch (err) {
        if (err?.code === 'P2025')
            return res.status(404).json({ error: 'Запись не найдена' });
        logger_1.logger.error({ err }, '[Закупки] удаление');
        res.status(500).json({ error: 'Не удалось удалить закупку', details: String(err?.message ?? err) });
    }
});
const ALL_MARKETPLACES = ['KASPI', 'OZON', 'WB'];
const MARKETPLACE_LABEL = { KASPI: 'Kaspi', OZON: 'Ozon', WB: 'Wildberries', APP: 'MyMarket' };
/** Не больше стольких накладных в одном ZIP — иначе serverless-функция не уложится по времени. */
const WHOLESALER_ZIP_LIMIT = 150;
// ---------------------------------------------------------------------
// Полки: список оптовиков, привязки, добавление, перенос товара
// ---------------------------------------------------------------------
/** Оптовики (в порядке добавления, у каждого своя площадка) и привязки товаров: { 'KASPI:<productId>': wholesalerId }. */
/**
 * Выплаты Ozon по полке оптовика: ?from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД&wholesalerId=<id|__none__|пусто = весь Ozon>.
 * Даты — по Алматы. Начислено Ozon в периоде, к выплате, оптовику, налог, чистая прибыль, периоды выплат.
 */
exports.wholesalersRouter.get('/ozon-payouts', async (req, res) => {
    try {
        const from = String(req.query.from || '');
        const to = String(req.query.to || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
            return res.status(400).json({ error: 'Нужны даты from и to (ГГГГ-ММ-ДД)' });
        const { getOzonPayoutReport } = await Promise.resolve().then(() => __importStar(require('../services/ozonPayouts.service')));
        const report = await getOzonPayoutReport({
            from: (0, timezone_1.almatyStartOfDay)(from),
            to: (0, timezone_1.almatyEndOfDay)(to),
            wholesalerId: req.query.wholesalerId ? String(req.query.wholesalerId) : null,
            marketplace: req.query.marketplace === 'TEEZ' ? 'TEEZ' : 'OZON',
        });
        res.json(report);
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Выплаты Ozon по полке');
        res.status(500).json({ error: String(err?.message ?? err) });
    }
});
exports.wholesalersRouter.get('/', async (_req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        const [wholesalers, links] = await Promise.all([
            prisma_1.prisma.wholesaler.findMany({ orderBy: { createdAt: 'asc' } }),
            prisma_1.prisma.wholesalerProduct.findMany({ select: { productId: true, marketplace: true, wholesalerId: true } }),
        ]);
        // Оптовики у каждой площадки свои, и один товар может стоять на полке и у Kaspi, и у Ozon:
        // привязка хранится на пару «товар + площадка», ключ в ответе — «KASPI:<id товара>».
        const assignments = {};
        for (const l of links)
            assignments[`${l.marketplace}:${l.productId}`] = l.wholesalerId;
        res.json({ wholesalers, assignments });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] GET / упал');
        res.status(500).json({ error: 'Не удалось получить оптовиков', details: String(err?.message ?? err) });
    }
});
/** Телефон необязателен: пустая строка = «нет телефона» (хранится как null). */
const phoneField = zod_1.z.string().trim().max(40).optional().nullable().transform((v) => (v ? v : null));
// APP — полки оптовиков витрины My Market (свои оптовики, заказы приложения ShopOrder).
const marketplaceEnum = zod_1.z.enum(['KASPI', 'OZON', 'WB', 'APP']);
const createSchema = zod_1.z.object({
    firstName: zod_1.z.string().trim().min(1).max(60),
    lastName: zod_1.z.string().trim().min(1).max(60),
    phone: phoneField,
    /** Оптовик принадлежит ровно одной площадке — той, что выбрана сверху. «Всё вместе» добавлять нельзя. */
    marketplace: marketplaceEnum,
});
/** Добавить оптовика — имя и фамилию вписывает сам пользователь. Количество не ограничено. */
exports.wholesalersRouter.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        const noMp = !req.body || !marketplaceEnum.safeParse(req.body.marketplace).success;
        return res.status(400).json({ error: noMp ? 'Сначала выбери Kaspi, Ozon или WB' : 'Укажите имя и фамилию оптовика', details: parsed.error.flatten() });
    }
    try {
        const wholesaler = await prisma_1.prisma.wholesaler.create({ data: parsed.data });
        res.status(201).json(wholesaler);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] POST / упал');
        res.status(500).json({ error: 'Не удалось добавить оптовика', details: String(err?.message ?? err) });
    }
});
const updateSchema = zod_1.z.object({
    firstName: zod_1.z.string().trim().min(1).max(60).optional(),
    lastName: zod_1.z.string().trim().min(1).max(60).optional(),
    phone: phoneField,
});
/**
 * Переименовать оптовика / сменить телефон. Меняются только переданные поля;
 * пустые имя или фамилия не принимаются. Товары полки привязаны к id оптовика,
 * поэтому ни привязки, ни продажи, ни накладные при этом не сбрасываются.
 */
exports.wholesalersRouter.patch('/:id', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Имя и фамилия не могут быть пустыми', details: parsed.error.flatten() });
    const data = {};
    if (parsed.data.firstName !== undefined)
        data.firstName = parsed.data.firstName;
    if (parsed.data.lastName !== undefined)
        data.lastName = parsed.data.lastName;
    // phone меняем, только если поле реально прислано (в т.ч. пустое — это очистка телефона).
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'phone'))
        data.phone = parsed.data.phone ?? null;
    if (!Object.keys(data).length)
        return res.status(400).json({ error: 'Нечего менять' });
    try {
        const exists = await prisma_1.prisma.wholesaler.findUnique({ where: { id: req.params.id }, select: { id: true } });
        if (!exists)
            return res.status(404).json({ error: 'Оптовик не найден' });
        const wholesaler = await prisma_1.prisma.wholesaler.update({ where: { id: req.params.id }, data });
        res.json(wholesaler);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] PATCH /:id упал');
        res.status(500).json({ error: 'Не удалось сохранить оптовика', details: String(err?.message ?? err) });
    }
});
/**
 * Удалить оптовика. Стираются ТОЛЬКО он сам и его привязки товаров
 * (WholesalerProduct). Товары, заказы, продажи и синхронизация не затрагиваются:
 * товар без привязки по правилу полок лежит на «Без оптовика».
 */
exports.wholesalersRouter.delete('/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const exists = await prisma_1.prisma.wholesaler.findUnique({ where: { id }, select: { id: true } });
        if (!exists)
            return res.status(404).json({ error: 'Оптовик не найден' });
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.wholesalerProduct.deleteMany({ where: { wholesalerId: id } }),
            prisma_1.prisma.wholesaler.delete({ where: { id } }),
        ]);
        res.json({ ok: true, id });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] DELETE /:id упал');
        res.status(500).json({ error: 'Не удалось удалить оптовика', details: String(err?.message ?? err) });
    }
});
const moveSchema = zod_1.z.object({
    productId: zod_1.z.string().min(1),
    /** Площадка полки: привязка хранится на пару «товар + площадка». */
    marketplace: marketplaceEnum,
    /** id оптовика; null — вернуть товар на полку «Без оптовика». */
    wholesalerId: zod_1.z.string().min(1).nullable(),
});
/**
 * Переместить товар на полку другого оптовика ТОЙ ЖЕ площадки. Один товар — одна
 * полка на площадку: запись перезаписывается, у прежнего оптовика товар пропадает сам. Сам товар
 * (себестоимость, цены, комиссия, логистика, налог) не меняется — меняется
 * только эта привязка.
 */
exports.wholesalersRouter.post('/move', async (req, res) => {
    const parsed = moveSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const { productId, wholesalerId, marketplace } = parsed.data;
        const product = await prisma_1.prisma.product.findUnique({
            where: { id: productId },
            select: { id: true, kaspiSku: true, ozonOfferId: true, wbArticle: true, sku: true, shopArticle: true },
        });
        if (!product)
            return res.status(404).json({ error: 'Товар не найден' });
        // Товар чужой площадки на полку не кладём. Витрина My Market — любой товар учёта.
        const own = marketplace === 'KASPI' ? product.kaspiSku : marketplace === 'OZON' ? product.ozonOfferId : marketplace === 'WB' ? product.wbArticle : (product.shopArticle ?? product.sku);
        if (!own)
            return res.status(400).json({ error: 'Этот товар не относится к выбранной площадке' });
        // My Market: товар уходит с отключённого магазина — возвращаем ему прежний остаток.
        const prev = marketplace === 'APP' ? await prisma_1.prisma.wholesalerProduct.findUnique({ where: { productId_marketplace: { productId, marketplace } } }) : null;
        const restoreStock = async () => {
            if (prev?.savedStock != null)
                await prisma_1.prisma.product.update({ where: { id: productId }, data: { shopStock: prev.savedStock } });
        };
        if (wholesalerId === null) {
            await prisma_1.prisma.wholesalerProduct.deleteMany({ where: { productId, marketplace } });
            await restoreStock();
            return res.json({ productId, marketplace, wholesalerId: null });
        }
        const wholesaler = await prisma_1.prisma.wholesaler.findUnique({ where: { id: wholesalerId }, select: { id: true, marketplace: true, disabled: true } });
        if (!wholesaler)
            return res.status(404).json({ error: 'Оптовик не найден' });
        if (wholesaler.marketplace !== marketplace)
            return res.status(400).json({ error: 'Оптовик другой площадки' });
        let savedStock = null;
        if (marketplace === 'APP') {
            if (wholesaler.disabled) {
                // На отключённый магазин: запоминаем остаток и ставим 0.
                const cur = await prisma_1.prisma.product.findUnique({ where: { id: productId }, select: { shopStock: true } });
                savedStock = prev?.savedStock ?? cur?.shopStock ?? 0;
                await prisma_1.prisma.product.update({ where: { id: productId }, data: { shopStock: 0 } });
            }
            else {
                await restoreStock();
            }
        }
        await prisma_1.prisma.wholesalerProduct.upsert({
            where: { productId_marketplace: { productId, marketplace } },
            update: { wholesalerId, assignedAt: new Date(), savedStock },
            create: { productId, marketplace, wholesalerId, savedStock },
        });
        res.json({ productId, marketplace, wholesalerId });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] POST /move упал');
        res.status(500).json({ error: 'Не удалось переместить товар', details: String(err?.message ?? err) });
    }
});
/**
 * Полки My Market одним запросом: товары витрины — в продаже и ещё не выставленные (например,
 * только что подтянутые «Синхронизировать с Ozon»; у них onSale=false), к какому оптовику привязаны,
 * сколько заказано СЕГОДНЯ (по Алматы) по товару и по полке, и города заказов за период — для накладных.
 */
exports.wholesalersRouter.get('/app/overview', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const { from, to } = parseRange(req.query);
        const todayStart = (0, timezone_1.almatyNow)().startOf('day').toDate();
        const periodStart = from < todayStart ? from : todayStart;
        const [products, links, orders, index] = await Promise.all([
            prisma_1.prisma.product.findMany({
                // Не только «В продаже»: товар витрины с ценой/артикулом, но выключенный, тоже лежит на
                // полке (по умолчанию «Без оптовика») — продавец сначала раскладывает, потом выставляет.
                where: { shopArchived: false, OR: [{ shopActive: true }, { shopPrice: { not: null } }, { shopArticle: { not: null } }] },
                select: { id: true, sku: true, shopArticle: true, name: true, shopPrice: true, shopStock: true, images: true, shopActive: true, category: true, type: true },
                orderBy: { name: 'asc' },
            }),
            prisma_1.prisma.wholesalerProduct.findMany({ where: { marketplace: 'APP' }, select: { productId: true, wholesalerId: true } }),
            prisma_1.prisma.shopOrder.findMany({ where: { createdAt: { gte: periodStart } } }),
            appProductIndex(),
        ]);
        const shelfOf = new Map(links.map((l) => [l.productId, l.wholesalerId]));
        const todayQty = {};
        const todayShelf = {};
        const periodShelf = {};
        const cities = new Map();
        for (const o of orders) {
            if (!isShippableStatus(o.status))
                continue;
            const created = new Date(o.createdAt);
            const inPeriod = created >= from && created <= to;
            if (inPeriod && o.city)
                cities.set(o.city, (cities.get(o.city) ?? 0) + 1);
            if (inPeriod) {
                // Заказы за период сверху страницы — по полкам (квадратик с числом у каждого оптовика).
                const seen = new Set();
                for (const line of parseAppItems(o.items)) {
                    const p = index.get(line.sku);
                    if (!p)
                        continue;
                    const shelf = shelfOf.get(p.id) ?? 'none';
                    const t = (periodShelf[shelf] ??= { orders: 0, qty: 0 });
                    t.qty += line.quantity;
                    seen.add(shelf);
                }
                for (const sh of seen)
                    periodShelf[sh].orders += 1;
            }
            if (created < todayStart)
                continue;
            const shelvesInOrder = new Set();
            for (const line of parseAppItems(o.items)) {
                const p = index.get(line.sku);
                if (!p)
                    continue;
                todayQty[p.id] = (todayQty[p.id] ?? 0) + line.quantity;
                const shelf = shelfOf.get(p.id) ?? 'none';
                const t = (todayShelf[shelf] ??= { orders: 0, qty: 0 });
                t.qty += line.quantity;
                shelvesInOrder.add(shelf);
            }
            for (const sh of shelvesInOrder)
                todayShelf[sh].orders += 1;
        }
        const firstImage = (raw) => {
            try {
                const a = JSON.parse(String(raw ?? '[]'));
                return Array.isArray(a) && typeof a[0] === 'string' ? a[0] : null;
            }
            catch {
                return null;
            }
        };
        res.json({
            products: products.map((p) => ({
                id: p.id, sku: p.shopArticle ?? p.sku, name: p.name, price: p.shopPrice, stock: p.shopStock,
                image: firstImage(p.images), wholesalerId: shelfOf.get(p.id) ?? null, todayQty: todayQty[p.id] ?? 0,
                onSale: !!p.shopActive, category: p.category ?? null, type: p.type ?? null,
            })),
            todayShelf,
            periodShelf,
            cities: [...cities.entries()].sort((a, b) => b[1] - a[1]).map(([city, count]) => ({ city, count })),
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] GET /app/overview упал');
        res.status(500).json({ error: 'Не удалось получить полки My Market', details: String(err?.message ?? err) });
    }
});
/**
 * My Market: переместить много товаров разом — на полку оптовика или обратно на «Без оптовика».
 * Остатки учитывают отключённые магазины так же, как одиночный перенос.
 */
exports.wholesalersRouter.post('/app/move-many', async (req, res) => {
    const parsed = zod_1.z.object({ productIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(5000), wholesalerId: zod_1.z.string().min(1).nullable() }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const { productIds, wholesalerId } = parsed.data;
        let target = null;
        if (wholesalerId) {
            target = await prisma_1.prisma.wholesaler.findUnique({ where: { id: wholesalerId }, select: { id: true, marketplace: true, disabled: true } });
            if (!target)
                return res.status(404).json({ error: 'Оптовик не найден' });
            if (target.marketplace !== 'APP')
                return res.status(400).json({ error: 'Оптовик другой площадки' });
        }
        const [products, prevLinks] = await Promise.all([
            prisma_1.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, shopStock: true } }),
            prisma_1.prisma.wholesalerProduct.findMany({ where: { productId: { in: productIds }, marketplace: 'APP' } }),
        ]);
        const prevOf = new Map(prevLinks.map((l) => [l.productId, l]));
        const ops = [];
        for (const p of products) {
            const prev = prevOf.get(p.id);
            if (!target) {
                if (prev)
                    ops.push(prisma_1.prisma.wholesalerProduct.delete({ where: { productId_marketplace: { productId: p.id, marketplace: 'APP' } } }));
                if (prev?.savedStock != null)
                    ops.push(prisma_1.prisma.product.update({ where: { id: p.id }, data: { shopStock: prev.savedStock } }));
                continue;
            }
            let savedStock = null;
            if (target.disabled) {
                savedStock = prev?.savedStock ?? p.shopStock ?? 0;
                ops.push(prisma_1.prisma.product.update({ where: { id: p.id }, data: { shopStock: 0 } }));
            }
            else if (prev?.savedStock != null) {
                ops.push(prisma_1.prisma.product.update({ where: { id: p.id }, data: { shopStock: prev.savedStock } }));
            }
            ops.push(prisma_1.prisma.wholesalerProduct.upsert({
                where: { productId_marketplace: { productId: p.id, marketplace: 'APP' } },
                update: { wholesalerId: target.id, assignedAt: new Date(), savedStock },
                create: { productId: p.id, marketplace: 'APP', wholesalerId: target.id, savedStock },
            }));
        }
        for (let i = 0; i < ops.length; i += 300)
            await prisma_1.prisma.$transaction(ops.slice(i, i + 300));
        res.json({ moved: products.length, wholesalerId });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] POST /app/move-many упал');
        res.status(500).json({ error: 'Не удалось переместить товары', details: String(err?.message ?? err) });
    }
});
/** Kaspi / Ozon / WB: переместить много товаров разом на полку оптовика этой площадки или на «Без оптовика». */
exports.wholesalersRouter.post('/move-many', async (req, res) => {
    const parsed = zod_1.z.object({
        productIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(5000),
        marketplace: zod_1.z.enum(['KASPI', 'OZON', 'WB']),
        wholesalerId: zod_1.z.string().min(1).nullable(),
    }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const { productIds, marketplace, wholesalerId } = parsed.data;
        if (wholesalerId) {
            const w = await prisma_1.prisma.wholesaler.findUnique({ where: { id: wholesalerId }, select: { marketplace: true } });
            if (!w)
                return res.status(404).json({ error: 'Оптовик не найден' });
            if (w.marketplace !== marketplace)
                return res.status(400).json({ error: 'Оптовик другой площадки' });
        }
        const products = await prisma_1.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, kaspiSku: true, ozonOfferId: true, wbArticle: true },
        });
        // Товары чужой площадки пропускаем — на полку Kaspi кладём только товары Kaspi.
        const own = products.filter((p) => (marketplace === 'KASPI' ? p.kaspiSku : marketplace === 'OZON' ? p.ozonOfferId : p.wbArticle));
        const ids = own.map((p) => p.id);
        if (!wholesalerId) {
            await prisma_1.prisma.wholesalerProduct.deleteMany({ where: { productId: { in: ids }, marketplace } });
        }
        else {
            const ops = ids.map((productId) => prisma_1.prisma.wholesalerProduct.upsert({
                where: { productId_marketplace: { productId, marketplace } },
                update: { wholesalerId, assignedAt: new Date() },
                create: { productId, marketplace, wholesalerId },
            }));
            for (let i = 0; i < ops.length; i += 300)
                await prisma_1.prisma.$transaction(ops.slice(i, i + 300));
        }
        res.json({ moved: ids.length, skipped: productIds.length - ids.length, marketplace, wholesalerId });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] POST /move-many упал');
        res.status(500).json({ error: 'Не удалось переместить товары', details: String(err?.message ?? err) });
    }
});
const stockSchema = zod_1.z.object({
    productIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(2000),
    stock: zod_1.z.number().int().min(0).max(100000),
});
/** My Market: остаток товарам полки — одному или пачкой («всем по 7 шт.»). Меняется только shopStock витрины. */
exports.wholesalersRouter.post('/app/stock', async (req, res) => {
    const parsed = stockSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Количество — целое число от 0', details: parsed.error.flatten() });
    try {
        const { productIds, stock } = parsed.data;
        const r = await prisma_1.prisma.product.updateMany({ where: { id: { in: productIds } }, data: { shopStock: stock } });
        // Товар отключённого магазина получил остаток вручную — это и будет остаток после включения.
        await prisma_1.prisma.wholesalerProduct.updateMany({ where: { productId: { in: productIds }, marketplace: 'APP', savedStock: { not: null } }, data: { savedStock: stock } });
        res.json({ updated: r.count, stock });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] POST /app/stock упал');
        res.status(500).json({ error: 'Не удалось сохранить количество', details: String(err?.message ?? err) });
    }
});
/**
 * My Market: включить / отключить магазин оптовика. Отключить — у всех его товаров остаток 0
 * (в приложении «нет в наличии»), прежний остаток запоминается. Включить — остаток возвращается.
 */
exports.wholesalersRouter.post('/app/enabled', async (req, res) => {
    const parsed = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(200), enabled: zod_1.z.boolean() }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const { ids, enabled } = parsed.data;
        const ws = await prisma_1.prisma.wholesaler.findMany({ where: { id: { in: ids }, marketplace: 'APP' } });
        let products = 0;
        for (const w of ws) {
            if (Boolean(w.disabled) === !enabled)
                continue; // уже в нужном состоянии — остатки не трогаем
            const links = await prisma_1.prisma.wholesalerProduct.findMany({ where: { wholesalerId: w.id, marketplace: 'APP' } });
            const items = links.length
                ? await prisma_1.prisma.product.findMany({ where: { id: { in: links.map((l) => l.productId) } }, select: { id: true, shopStock: true } })
                : [];
            const stockOf = new Map(items.map((p) => [p.id, p.shopStock ?? 0]));
            const ops = [];
            for (const l of links) {
                if (!stockOf.has(l.productId))
                    continue;
                if (!enabled) {
                    ops.push(prisma_1.prisma.wholesalerProduct.update({ where: { productId_marketplace: { productId: l.productId, marketplace: 'APP' } }, data: { savedStock: stockOf.get(l.productId) } }));
                    ops.push(prisma_1.prisma.product.update({ where: { id: l.productId }, data: { shopStock: 0 } }));
                }
                else {
                    ops.push(prisma_1.prisma.product.update({ where: { id: l.productId }, data: { shopStock: l.savedStock ?? stockOf.get(l.productId) ?? 0 } }));
                    ops.push(prisma_1.prisma.wholesalerProduct.update({ where: { productId_marketplace: { productId: l.productId, marketplace: 'APP' } }, data: { savedStock: null } }));
                }
                products += 1;
            }
            ops.push(prisma_1.prisma.wholesaler.update({ where: { id: w.id }, data: { disabled: !enabled } }));
            await prisma_1.prisma.$transaction(ops);
        }
        res.json({ ok: true, enabled, wholesalers: ws.length, products });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] POST /app/enabled упал');
        res.status(500).json({ error: 'Не удалось переключить магазин', details: String(err?.message ?? err) });
    }
});
// ---------------------------------------------------------------------
// Накладные: по одной PDF и пачкой ZIP
// ---------------------------------------------------------------------
/** Заказ отменён/возвращён (статусы у площадок — свободный текст) — накладную на него не делаем. */
function isShippableStatus(status) {
    return !/cancel|return/i.test(status ?? '');
}
function parseMarketplaces(raw) {
    if (raw === undefined || raw === '' || raw === null)
        return ALL_MARKETPLACES; // «Всё вместе»
    const v = String(raw).toUpperCase();
    if (v === 'APP')
        return ['APP']; // витрина My Market — только явно, в «Всё вместе» не входит
    return ALL_MARKETPLACES.includes(v) ? [v] : null;
}
function parseRange(query) {
    const to = typeof query.to === 'string' && query.to ? (0, timezone_1.almatyEndOfDay)(query.to) : (0, timezone_1.almatyNow)().endOf('day').toDate();
    const from = typeof query.from === 'string' && query.from
        ? (0, timezone_1.almatyStartOfDay)(query.from)
        : (0, dayjs_1.default)(to).tz(timezone_1.ALMATY_TZ).subtract(30, 'day').startOf('day').toDate();
    return { from, to };
}
const safeName = (s) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'x';
function articleFor(marketplace, product, externalSku) {
    const own = marketplace === 'KASPI' ? product?.kaspiSku : marketplace === 'OZON' ? product?.ozonOfferId : marketplace === 'WB' ? product?.wbArticle : product?.shopArticle;
    return own ?? externalSku ?? null;
}
const ORDER_INCLUDE = {
    items: { include: { product: { select: { sku: true, kaspiSku: true, ozonOfferId: true, wbArticle: true } } } },
};
function parseAppItems(raw) {
    try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(arr))
            return [];
        return arr
            .map((i) => ({ sku: String(i?.sku ?? '').trim(), name: String(i?.name ?? '').trim(), quantity: Math.max(1, Math.round(Number(i?.quantity ?? i?.qty ?? 1)) || 1) }))
            .filter((i) => i.sku);
    }
    catch {
        return [];
    }
}
/** Карта «sku/артикул витрины → товар» для заказов приложения. */
async function appProductIndex() {
    const products = await prisma_1.prisma.product.findMany({ select: { id: true, sku: true, shopArticle: true, name: true } });
    const map = new Map();
    for (const p of products) {
        if (p.sku)
            map.set(String(p.sku), p);
        if (p.shopArticle)
            map.set(String(p.shopArticle), p);
    }
    return map;
}
const sameCity = (a, b) => String(a ?? '').trim().toLowerCase().replace(/ё/g, 'е') === String(b ?? '').trim().toLowerCase().replace(/ё/g, 'е');
exports.sameCity = sameCity;
async function collectAppJobs(wholesalerName, idSet, from, to, city) {
    const [orders, index] = await Promise.all([
        prisma_1.prisma.shopOrder.findMany({ where: { createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' } }),
        appProductIndex(),
    ]);
    const jobs = [];
    for (const order of orders) {
        if (!isShippableStatus(order.status))
            continue;
        if (city && !(0, exports.sameCity)(order.city, city))
            continue;
        const items = parseAppItems(order.items)
            .map((i) => ({ i, p: index.get(i.sku) }))
            .filter(({ p }) => p && idSet.has(p.id))
            .map(({ i, p }) => ({ sku: p.sku ?? i.sku, article: p.shopArticle ?? i.sku, name: i.name || p.name, quantity: i.quantity }));
        if (!items.length)
            continue;
        jobs.push({ wholesalerName, marketplace: 'APP', orderNumber: order.number, orderDate: order.createdAt, city: order.city ?? null, items });
    }
    return jobs;
}
/** Накладные одной полки: заказы за период по товарам этого оптовика, по каждой выбранной площадке отдельно. */
async function collectJobs(wholesaler, allMarketplaces, from, to, city = null) {
    // Оптовик принадлежит одной площадке — накладные только по ней (чужие площадки не смешиваем).
    const marketplaces = allMarketplaces.filter((m) => !wholesaler.marketplace || m === wholesaler.marketplace);
    const links = await prisma_1.prisma.wholesalerProduct.findMany({
        where: { wholesalerId: wholesaler.id },
        select: { productId: true },
    });
    const productIds = links.map((l) => l.productId);
    if (!productIds.length)
        return [];
    const idSet = new Set(productIds);
    const wholesalerName = `${wholesaler.firstName} ${wholesaler.lastName}`;
    const jobs = [];
    for (const marketplace of marketplaces) {
        if (marketplace === 'APP') {
            jobs.push(...(await collectAppJobs(wholesalerName, idSet, from, to, city)));
            continue;
        }
        const orders = await prisma_1.prisma.order.findMany({
            where: { marketplace, orderDate: { gte: from, lte: to }, items: { some: { productId: { in: productIds } } } },
            orderBy: { orderDate: 'desc' },
            include: ORDER_INCLUDE,
        });
        for (const order of orders) {
            if (!isShippableStatus(order.status))
                continue;
            // Только товары ЭТОГО оптовика — чужие позиции того же заказа в его накладную не попадают.
            const items = order.items
                .filter((i) => i.productId && idSet.has(i.productId))
                .map((i) => ({
                sku: i.product?.sku ?? i.externalSku,
                article: articleFor(marketplace, i.product, i.externalSku),
                name: i.name,
                quantity: i.quantity,
            }));
            if (!items.length)
                continue;
            jobs.push({ wholesalerName, marketplace, orderNumber: order.externalId, orderDate: order.orderDate, city: order.city ?? null, items });
        }
    }
    return jobs;
}
async function sendZip(res, jobs, opts) {
    const total = jobs.length;
    const batch = jobs.slice(0, WHOLESALER_ZIP_LIMIT);
    const zip = new jszip_1.default();
    let included = 0;
    let failed = 0;
    for (const job of batch) {
        try {
            const pdf = await generateWholesalerWaybillPdf(job);
            const parts = [];
            if (opts.multipleWholesalers)
                parts.push(safeName(job.wholesalerName));
            // Kaspi / Ozon / WB в одном ZIP не смешиваются: при «Всё вместе» — отдельные папки.
            if (opts.multipleMarketplaces)
                parts.push(MARKETPLACE_LABEL[job.marketplace]);
            // My Market: накладные разложены по папкам городов — удобно отдавать пачками по городу.
            if (job.marketplace === 'APP')
                parts.push(safeName(job.city || 'Без города'));
            parts.push(`${MARKETPLACE_LABEL[job.marketplace]}_${safeName(job.orderNumber)}.pdf`);
            zip.file(parts.join('/'), pdf);
            included += 1;
        }
        catch (err) {
            failed += 1;
            logger_1.logger.warn({ err: String(err?.message ?? err), orderNumber: job.orderNumber }, '[Wholesalers] накладная не собралась — пропущена в ZIP');
        }
    }
    if (!included) {
        return res.status(500).json({ error: 'Ни одна накладная не собралась' });
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="waybills.zip"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`);
    res.setHeader('X-Waybills-Total', String(total));
    res.setHeader('X-Waybills-Included', String(included));
    res.setHeader('X-Waybills-Failed', String(failed));
    res.setHeader('Access-Control-Expose-Headers', 'X-Waybills-Total, X-Waybills-Included, X-Waybills-Failed');
    res.send(buffer);
}
const ddmm = () => (0, timezone_1.almatyNow)().format('DD-MM');
/**
 * ZIP накладных по ВЫБРАННЫМ полкам: ?ids=a,b,c — id оптовиков,
 * ?marketplace=KASPI|OZON|WB (пусто — все три, каждая в своей папке),
 * ?from=&to= — период (как сверху на странице). Путь /waybills.zip объявлен
 * раньше /:id/..., чтобы «waybills.zip» не принимался за id.
 */
exports.wholesalersRouter.get('/waybills.zip', async (req, res) => {
    try {
        const marketplaces = parseMarketplaces(req.query.marketplace);
        if (!marketplaces)
            return res.status(400).json({ error: 'Площадка должна быть KASPI, OZON или WB' });
        const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!ids.length)
            return res.status(400).json({ error: 'Не выбрано ни одной полки' });
        const wholesalers = await prisma_1.prisma.wholesaler.findMany({
            where: { id: { in: ids } },
            orderBy: { createdAt: 'asc' },
        });
        if (!wholesalers.length)
            return res.status(404).json({ error: 'Оптовики не найдены' });
        const { from, to } = parseRange(req.query);
        const city = typeof req.query.city === 'string' && req.query.city.trim() ? req.query.city.trim() : null;
        const jobs = [];
        for (const w of wholesalers)
            jobs.push(...(await collectJobs(w, marketplaces, from, to, city)));
        if (!jobs.length)
            return res.status(404).json({ error: 'За выбранный период нет заказов по товарам этих оптовиков' });
        await sendZip(res, jobs, {
            multipleWholesalers: wholesalers.length > 1,
            multipleMarketplaces: marketplaces.length > 1,
            fileName: wholesalers.length > 1
                ? `Накладные_оптовики_${ddmm()}.zip`
                : `${safeName(`${wholesalers[0].firstName}_${wholesalers[0].lastName}`)}_${marketplaces.length > 1 ? 'все-площадки' : MARKETPLACE_LABEL[marketplaces[0]]}_${ddmm()}.zip`,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] GET /waybills.zip упал');
        res.status(500).json({ error: 'Не удалось собрать накладные', details: String(err?.message ?? err) });
    }
});
/** ZIP накладных ОДНОЙ полки оптовика. */
exports.wholesalersRouter.get('/:id/waybills.zip', async (req, res) => {
    try {
        const marketplaces = parseMarketplaces(req.query.marketplace);
        if (!marketplaces)
            return res.status(400).json({ error: 'Площадка должна быть KASPI, OZON или WB' });
        const wholesaler = await prisma_1.prisma.wholesaler.findUnique({ where: { id: req.params.id } });
        if (!wholesaler)
            return res.status(404).json({ error: 'Оптовик не найден' });
        const { from, to } = parseRange(req.query);
        const city = typeof req.query.city === 'string' && req.query.city.trim() ? req.query.city.trim() : null;
        const jobs = await collectJobs(wholesaler, marketplaces, from, to, city);
        if (!jobs.length)
            return res.status(404).json({ error: 'За выбранный период нет заказов по товарам этого оптовика' });
        await sendZip(res, jobs, {
            multipleWholesalers: false,
            multipleMarketplaces: marketplaces.length > 1,
            fileName: `${safeName(`${wholesaler.firstName}_${wholesaler.lastName}`)}_${marketplaces.length > 1 ? 'все-площадки' : MARKETPLACE_LABEL[marketplaces[0]]}_${ddmm()}.zip`,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] GET /:id/waybills.zip упал');
        res.status(500).json({ error: 'Не удалось собрать накладные', details: String(err?.message ?? err) });
    }
});
/**
 * Одна накладная PDF по строке товара: на ПОСЛЕДНИЙ (не отменённый и не
 * возвращённый) заказ этого товара на выбранной площадке. В накладной — этот
 * товар и остальные товары того же оптовика из этого же заказа; город — из заказа.
 */
exports.wholesalersRouter.get('/products/:productId/waybill.pdf', async (req, res) => {
    try {
        const marketplaces = parseMarketplaces(req.query.marketplace);
        if (!marketplaces || marketplaces.length !== 1)
            return res.status(400).json({ error: 'Укажите площадку: KASPI, OZON или WB' });
        const marketplace = marketplaces[0];
        const productId = req.params.productId;
        const link = await prisma_1.prisma.wholesalerProduct.findUnique({ where: { productId_marketplace: { productId, marketplace } }, include: { wholesaler: true } });
        let sameShelfIds = new Set([productId]);
        let wholesalerName = 'Без оптовика';
        if (link) {
            const siblings = await prisma_1.prisma.wholesalerProduct.findMany({
                where: { wholesalerId: link.wholesalerId },
                select: { productId: true },
            });
            sameShelfIds = new Set(siblings.map((s) => s.productId));
            wholesalerName = `${link.wholesaler.firstName} ${link.wholesaler.lastName}`;
        }
        const orders = await prisma_1.prisma.order.findMany({
            where: { marketplace, items: { some: { productId } } },
            orderBy: { orderDate: 'desc' },
            take: 30,
            include: ORDER_INCLUDE,
        });
        const order = orders.find((o) => isShippableStatus(o.status));
        if (!order)
            return res.status(404).json({ error: 'По этому товару на выбранной площадке нет заказов для накладной' });
        const items = order.items
            .filter((i) => i.productId && sameShelfIds.has(i.productId))
            .map((i) => ({
            sku: i.product?.sku ?? i.externalSku,
            article: articleFor(marketplace, i.product, i.externalSku),
            name: i.name,
            quantity: i.quantity,
        }));
        const pdf = await generateWholesalerWaybillPdf({
            wholesalerName,
            marketplace,
            orderNumber: order.externalId,
            orderDate: order.orderDate,
            city: order.city ?? null,
            items,
        });
        const fileName = `waybill-${MARKETPLACE_LABEL[marketplace]}-${safeName(order.externalId)}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.send(pdf);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Wholesalers] GET /products/:productId/waybill.pdf упал');
        res.status(500).json({ error: 'Не удалось собрать накладную', details: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=wholesalers.routes.js.map