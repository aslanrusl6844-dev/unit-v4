"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUGGEST_LIMIT = exports.SUGGEST_MAX_LEN = exports.SUGGEST_MIN_LEN = void 0;
exports.normalizeSuggestQuery = normalizeSuggestQuery;
exports.getSearchSuggestions = getSearchSuggestions;
const prisma_1 = require("../db/prisma");
/**
 * Подсказки поиска My Market. Источники: категории, типы, популярные
 * (успешные) запросы покупателей и названия товаров — только из товаров,
 * которые видны в приложении. Текущий поиск товаров не затрагивается.
 */
exports.SUGGEST_MIN_LEN = 2;
exports.SUGGEST_MAX_LEN = 50;
exports.SUGGEST_LIMIT = 10;
const POPULAR_DAYS = 90;
const POPULAR_MIN_COUNT = 2; // запрос должен повториться — разовые строки (в т.ч. личные) не показываем
const MAX_LABEL = 80;
function normalizeSuggestQuery(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, exports.SUGGEST_MAX_LEN);
}
/** Совпадение с начала слова ранжируем выше, чем «где-то внутри». */
function rank(text, q) {
    const t = text.toLowerCase();
    if (t.startsWith(q))
        return 0;
    if (t.split(/[\s\-/,()]+/).some((w) => w.startsWith(q)))
        return 1;
    return 2;
}
function pushUnique(out, seen, text, type, limit) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t)
        return;
    const label = t.length > MAX_LABEL ? t.slice(0, MAX_LABEL).trim() : t;
    const key = label.toLowerCase();
    if (seen.has(key) || out.length >= limit)
        return;
    seen.add(key);
    out.push({ text: label, type });
}
async function getSearchSuggestions(rawQuery, visibleWhere, now = new Date()) {
    const q = normalizeSuggestQuery(rawQuery);
    if (q.length < exports.SUGGEST_MIN_LEN)
        return [];
    const contains = { contains: q, mode: 'insensitive' };
    const [products, popular] = await Promise.all([
        prisma_1.prisma.product.findMany({
            where: { ...visibleWhere, OR: [{ name: contains }, { category: contains }, { type: contains }] },
            select: { name: true, category: true, type: true },
            take: 300,
        }),
        prisma_1.prisma.shopEvent.groupBy({
            by: ['query'],
            where: {
                type: 'search',
                resultsCount: { gt: 0 },
                createdAt: { gte: new Date(now.getTime() - POPULAR_DAYS * 86400_000) },
                query: { startsWith: q, mode: 'insensitive' },
            },
            _count: { query: true },
            having: { query: { _count: { gte: POPULAR_MIN_COUNT } } },
            orderBy: { _count: { query: 'desc' } },
            take: 5,
        }),
    ]);
    const has = (s) => typeof s === 'string' && s.toLowerCase().includes(q);
    const categories = Array.from(new Set(products.map((p) => p.category).filter(has)));
    const types = Array.from(new Set(products.map((p) => p.type).filter(has)));
    const names = Array.from(new Set(products.map((p) => p.name).filter(has)));
    const byRank = (a, b) => rank(a, q) - rank(b, q) || a.length - b.length || a.localeCompare(b, 'ru');
    const out = [];
    const seen = new Set();
    categories.sort(byRank).slice(0, 2).forEach((c) => pushUnique(out, seen, c, 'category', exports.SUGGEST_LIMIT));
    types.sort(byRank).slice(0, 2).forEach((t) => pushUnique(out, seen, t, 'type', exports.SUGGEST_LIMIT));
    popular.forEach((r) => pushUnique(out, seen, r.query, 'popular', exports.SUGGEST_LIMIT));
    names.sort(byRank).forEach((n) => pushUnique(out, seen, n, 'product', exports.SUGGEST_LIMIT));
    return out;
}
//# sourceMappingURL=searchSuggestions.service.js.map