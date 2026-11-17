"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HUB_CITY = void 0;
exports.buildGeo = buildGeo;
exports.getGeoAnalytics = getGeoAnalytics;
const prisma_1 = require("../db/prisma");
const cities_1 = require("../config/cities");
/**
 * Карта доставок My Market: заказы и поисковые запросы по городам приложения
 * (тот же список из 20 городов, что и в настройках приложения/«Картинки городов»),
 * плюс «машины в пути» — заказы picked/in_transit, сгруппированные по городу.
 * Хаб — Алматы. Всё считается только по каналу APP (ShopOrder / ShopEvent).
 */
exports.HUB_CITY = 'Алматы';
function parseItems(raw) {
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr))
            return [];
        return arr
            .map((i) => ({ name: String(i?.name ?? '').trim(), quantity: Number(i?.quantity) > 0 ? Number(i.quantity) : 1 }))
            .filter((i) => i.name);
    }
    catch {
        return [];
    }
}
function topN(m, n) {
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
}
/** Чистая функция — вся логика агрегации здесь, чтобы её можно было проверить тестом без БД. */
function buildGeo(orders, searches) {
    const cities = new Map();
    for (const c of cities_1.CITY_IMAGE_CITIES) {
        cities.set(c, {
            city: c, orders: 0, revenue: 0, topItems: [], searches: 0, topQueries: [], paid: 0, inTransit: 0,
            transitSince: null, delivered: 0, lastDeliveredAt: null,
            _items: new Map(), _queries: new Map(), _since: null, _lastDel: null,
        });
    }
    let otherOrders = 0;
    let otherSearches = 0;
    for (const o of orders) {
        if (o.status === 'pending_payment' || o.status === 'cancelled')
            continue;
        const name = (0, cities_1.resolveCity)(o.city);
        const c = name ? cities.get(name) : null;
        if (!c) {
            otherOrders++;
            continue;
        }
        c.orders++;
        c.revenue += o.total;
        for (const it of parseItems(o.items))
            c._items.set(it.name, (c._items.get(it.name) ?? 0) + it.quantity);
        if (o.status === 'paid')
            c.paid++;
        else if (o.status === 'picked' || o.status === 'in_transit') {
            c.inTransit++;
            const t = o.updatedAt.getTime();
            c._since = c._since == null ? t : Math.min(c._since, t);
        }
        else if (o.status === 'delivered') {
            c.delivered++;
            const t = (o.deliveredAt ?? o.updatedAt).getTime();
            c._lastDel = c._lastDel == null ? t : Math.max(c._lastDel, t);
        }
    }
    for (const s of searches) {
        const q = (s.query ?? '').trim().toLowerCase();
        if (!q)
            continue;
        const name = (0, cities_1.resolveCity)(s.city);
        const c = name ? cities.get(name) : null;
        if (!c) {
            otherSearches++;
            continue;
        }
        c.searches++;
        c._queries.set(q, (c._queries.get(q) ?? 0) + 1);
    }
    const list = Array.from(cities.values()).map((c) => ({
        city: c.city,
        orders: c.orders,
        revenue: Math.round(c.revenue),
        topItems: topN(c._items, 3).map(([name, qty]) => ({ name, qty })),
        searches: c.searches,
        topQueries: topN(c._queries, 3).map(([query, count]) => ({ query, count })),
        paid: c.paid,
        inTransit: c.inTransit,
        transitSince: c._since == null ? null : new Date(c._since).toISOString(),
        delivered: c.delivered,
        lastDeliveredAt: c._lastDel == null ? null : new Date(c._lastDel).toISOString(),
    }));
    return { hub: exports.HUB_CITY, cities: list, otherOrders, otherSearches };
}
async function getGeoAnalytics(days) {
    const from = new Date();
    from.setDate(from.getDate() - days);
    from.setHours(0, 0, 0, 0);
    const [orders, searches] = await Promise.all([
        prisma_1.prisma.shopOrder.findMany({
            where: days > 0 ? { createdAt: { gte: from } } : {},
            select: { city: true, status: true, total: true, items: true, createdAt: true, updatedAt: true, deliveredAt: true },
        }),
        prisma_1.prisma.shopEvent.findMany({
            where: { type: 'search', ...(days > 0 ? { createdAt: { gte: from } } : {}) },
            select: { id: true, city: true, query: true, phone: true },
        }),
    ]);
    return buildGeo(orders, searches);
}
//# sourceMappingURL=shopGeo.service.js.map