"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ozonFboRouter = void 0;
const express_1 = require("express");
const ozon_client_1 = require("../integrations/ozon.client");
const timezone_1 = require("../utils/timezone");
exports.ozonFboRouter = (0, express_1.Router)();
const msg = (err) => String(err?.message ?? err);
/**
 * GET /api/ozon-fbo?from=&to= — раздел FBO: остатки на складах Ozon и продажи
 * FBO за период (по товарам). Возвраты — отдельная вкладка (/api/ozon-returns). Каждый блок
 * загружается отдельно: ошибка одного не ломает остальные.
 */
exports.ozonFboRouter.get('/', async (req, res) => {
    const { from, to } = req.query;
    const dateTo = to ? (0, timezone_1.almatyEndOfDay)(to) : new Date();
    const dateFrom = from ? (0, timezone_1.almatyStartOfDay)(from) : new Date(dateTo.getTime() - 30 * 24 * 3600 * 1000);
    const [stocksR, postingsR] = await Promise.allSettled([
        ozon_client_1.ozonClient.fetchFboStocks(),
        ozon_client_1.ozonClient.fetchFboPostings(dateFrom, dateTo),
    ]);
    const stocks = stocksR.status === 'fulfilled' ? stocksR.value : [];
    const soldMap = new Map();
    if (postingsR.status === 'fulfilled') {
        for (const p of postingsR.value) {
            const key = p.offerId || p.name;
            const e = soldMap.get(key) ?? { offerId: p.offerId, name: p.name, sold: 0, cancelled: 0, revenue: 0 };
            if (/cancel/i.test(p.status))
                e.cancelled += p.quantity;
            else {
                e.sold += p.quantity;
                e.revenue += p.price * p.quantity;
            }
            soldMap.set(key, e);
        }
    }
    res.json({
        ok: true,
        stocks: { rows: stocks, error: stocksR.status === 'rejected' ? msg(stocksR.reason) : null },
        sold: { rows: Array.from(soldMap.values()).sort((a, b) => b.sold - a.sold), error: postingsR.status === 'rejected' ? msg(postingsR.reason) : null },
    });
});
//# sourceMappingURL=ozonFbo.routes.js.map