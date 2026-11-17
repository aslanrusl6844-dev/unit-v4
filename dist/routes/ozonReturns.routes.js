"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ozonReturnsRouter = void 0;
const express_1 = require("express");
const ozon_client_1 = require("../integrations/ozon.client");
const timezone_1 = require("../utils/timezone");
const logger_1 = require("../utils/logger");
exports.ozonReturnsRouter = (0, express_1.Router)();
/**
 * GET /api/ozon-returns/pickup — ВСЕ возвраты Ozon (без периода), разложенные для забора:
 *  - ready: уже лежат на складе возвратов в Алматы (place = АЛМАТЫ_..._ВОЗВРАТЫ, Ельтай) — забрать;
 *  - coming: едут туда (target_place = АЛМАТЫ_..._ВОЗВРАТЫ, а place — другой склад).
 * Сроки платного хранения и утилизации — из блока storage Ozon.
 */
exports.ozonReturnsRouter.get('/pickup', async (_req, res) => {
    try {
        const all = await ozon_client_1.ozonClient.fetchReturns(null, null);
        const isAlmatyReturns = (name) => /алматы/i.test(name) && /возврат/i.test(name);
        // Уже забранные/завершённые возвраты не показываем.
        const finished = (r) => /returned_to_seller|utiliz|dispos/i.test(r.statusSysName) || /выдан продавцу|вручен продавцу|утилизир/i.test(r.status);
        const ready = all.filter((r) => isAlmatyReturns(r.placeName) && !finished(r));
        const coming = all.filter((r) => !isAlmatyReturns(r.placeName) && isAlmatyReturns(r.targetPlaceName) && !finished(r));
        logger_1.logger.info({ total: all.length, ready: ready.map((r) => [r.postingNumber, r.offerId, r.placeName, r.statusSysName]), coming: coming.map((r) => [r.postingNumber, r.offerId, r.placeName, r.targetPlaceName]), sampleStorage: ready[0]?.storage ?? null }, '[Ozon] Возвраты к забору');
        res.json({ ok: true, total: all.length, ready, coming });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка возвратов Ozon к забору');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
/** GET /api/ozon-returns?from=YYYY-MM-DD&to=YYYY-MM-DD — возвраты Ozon напрямую из API (без записи в базу). */
exports.ozonReturnsRouter.get('/', async (req, res) => {
    try {
        const { from, to } = req.query;
        const dateTo = to ? (0, timezone_1.almatyEndOfDay)(to) : new Date();
        const dateFrom = from ? (0, timezone_1.almatyStartOfDay)(from) : new Date(dateTo.getTime() - 60 * 24 * 3600 * 1000);
        const returns = await ozon_client_1.ozonClient.fetchReturns(dateFrom, dateTo);
        res.json({ ok: true, total: returns.length, returns });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка загрузки возвратов Ozon');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=ozonReturns.routes.js.map