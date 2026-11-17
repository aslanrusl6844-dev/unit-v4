"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRENDS_REGIONS = void 0;
exports.getMySalesByKeyword = getMySalesByKeyword;
exports.parseTrendsJson = parseTrendsJson;
exports.mapTimeline = mapTimeline;
exports.mapRelated = mapRelated;
exports.getGoogleTrends = getGoogleTrends;
const dayjs_1 = __importDefault(require("dayjs"));
const google_trends_api_1 = __importDefault(require("google-trends-api"));
const prisma_1 = require("../db/prisma");
const analytics_service_1 = require("./analytics.service");
/** Регионы Казахстана для Google Trends (коды Google; список можно расширять). */
exports.TRENDS_REGIONS = {
    KZ: 'Казахстан',
    'KZ-ALA': 'Алматы',
    'KZ-AST': 'Астана',
    'KZ-SHY': 'Шымкент',
};
const MARKETPLACES = ['KASPI', 'OZON', 'WB', 'TEEZ', 'APP'];
const ITEM_LIMIT = 50_000;
/**
 * Продажи ТВОИХ товаров, в названии которых есть слово — по месяцам и площадкам.
 * Считаются только заказы, не входящие в NON_SALE_STATUSES (без отмен и возвратов).
 * Это данные из нашей базы, не оценка.
 */
async function getMySalesByKeyword(keyword, from, to, db = prisma_1.prisma) {
    const words = keyword.trim().split(/\s+/).filter(Boolean).slice(0, 5);
    const items = await db.orderItem.findMany({
        where: {
            AND: words.map((w) => ({ name: { contains: w, mode: 'insensitive' } })),
            order: { orderDate: { gte: from, lte: to }, status: { notIn: analytics_service_1.NON_SALE_STATUSES } },
        },
        select: { name: true, quantity: true, price: true, order: { select: { marketplace: true, orderDate: true } } },
        take: ITEM_LIMIT + 1,
    });
    const truncated = items.length > ITEM_LIMIT;
    if (truncated)
        items.length = ITEM_LIMIT;
    // Пустые месяцы тоже показываем — иначе график «проваливается» без объяснения.
    const monthMap = new Map();
    for (let m = (0, dayjs_1.default)(from).startOf('month'); !m.isAfter(to); m = m.add(1, 'month')) {
        monthMap.set(m.format('YYYY-MM'), { month: m.format('YYYY-MM'), byMarketplace: {}, quantity: 0, revenue: 0 });
    }
    const totals = { all: { quantity: 0, revenue: 0 } };
    const products = new Map();
    for (const it of items) {
        const key = (0, dayjs_1.default)(it.order.orderDate).format('YYYY-MM');
        const bucket = monthMap.get(key);
        if (!bucket)
            continue;
        const mp = it.order.marketplace;
        const revenue = it.price * it.quantity;
        const cell = (bucket.byMarketplace[mp] ??= { quantity: 0, revenue: 0 });
        cell.quantity += it.quantity;
        cell.revenue += revenue;
        bucket.quantity += it.quantity;
        bucket.revenue += revenue;
        const tot = (totals[mp] ??= { quantity: 0, revenue: 0 });
        tot.quantity += it.quantity;
        tot.revenue += revenue;
        totals.all.quantity += it.quantity;
        totals.all.revenue += revenue;
        const p = products.get(it.name) ?? { name: it.name, quantity: 0, revenue: 0 };
        p.quantity += it.quantity;
        p.revenue += revenue;
        products.set(it.name, p);
    }
    const round = (n) => Math.round(n);
    const months = [...monthMap.values()].map((m) => ({
        ...m,
        revenue: round(m.revenue),
        byMarketplace: Object.fromEntries(Object.entries(m.byMarketplace).map(([k, v]) => [k, { quantity: v.quantity, revenue: round(v.revenue) }])),
    }));
    for (const k of Object.keys(totals))
        totals[k].revenue = round(totals[k].revenue);
    return {
        keyword,
        from: (0, dayjs_1.default)(from).format('YYYY-MM-DD'),
        to: (0, dayjs_1.default)(to).format('YYYY-MM-DD'),
        months,
        totals,
        topProducts: [...products.values()]
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 10)
            .map((p) => ({ ...p, revenue: round(p.revenue) })),
        truncated,
    };
}
/** Ответ Trends — JSON, но при блокировке приходит HTML; делаем из этого понятную ошибку. */
function parseTrendsJson(raw, what) {
    const text = String(raw ?? '').trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
        throw new Error(`Google Trends не отдал данные (${what}): сервер вернул не JSON — вероятно, временно ограничил запросы с нашего хостинга.`);
    }
    return JSON.parse(text);
}
function mapTimeline(json) {
    const points = json?.default?.timelineData ?? [];
    return points.map((p) => ({
        date: dayjs_1.default.unix(Number(p.time)).format('YYYY-MM-DD'),
        value: Number(Array.isArray(p.value) ? p.value[0] : p.value) || 0,
    }));
}
function mapRelated(json) {
    const lists = json?.default?.rankedList ?? [];
    const top = (lists[0]?.rankedKeyword ?? []).map((k) => ({ query: String(k.query), value: Number(k.value) || 0 }));
    const rising = (lists[1]?.rankedKeyword ?? []).map((k) => ({
        query: String(k.query),
        value: k.formattedValue ? String(k.formattedValue) : String(k.value ?? ''),
    }));
    return { top: top.slice(0, 25), rising: rising.slice(0, 25) };
}
async function getGoogleTrends(keyword, geo, months) {
    if (!(geo in exports.TRENDS_REGIONS))
        throw new Error('Неизвестный регион');
    const endTime = new Date();
    const startTime = (0, dayjs_1.default)(endTime).subtract(Math.min(Math.max(months, 1), 60), 'month').toDate();
    const opts = { keyword, geo, startTime, endTime, hl: 'ru', timezone: -300 };
    const timeline = mapTimeline(parseTrendsJson(await google_trends_api_1.default.interestOverTime(opts), 'динамика'));
    // Связанные запросы — вторым запросом; если Google на нём откажет, динамику всё равно покажем.
    let related = { top: [], rising: [] };
    try {
        related = mapRelated(parseTrendsJson(await google_trends_api_1.default.relatedQueries(opts), 'связанные запросы'));
    }
    catch {
        /* оставляем пустые списки */
    }
    return {
        keyword,
        geo,
        geoLabel: exports.TRENDS_REGIONS[geo],
        timeline,
        relatedTop: related.top,
        relatedRising: related.rising,
    };
}
//# sourceMappingURL=searchAnalytics.service.js.map