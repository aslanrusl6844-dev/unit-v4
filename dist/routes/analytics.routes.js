"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyticsRouter = void 0;
const express_1 = require("express");
const dayjs_1 = __importDefault(require("dayjs"));
const analytics_service_1 = require("../services/analytics.service");
const taxSettings_1 = require("../handlers/taxSettings");
const timezone_1 = require("../utils/timezone");
exports.analyticsRouter = (0, express_1.Router)();
// ВАЖНО: границы дня считаются по часовому поясу Алматы (см.
// src/utils/timezone.ts), а не по часовому поясу сервера (на Vercel это
// UTC) — иначе заказы вечера по Алматы попадали не в тот календарный день.
function parseRange(query) {
    const to = query.to ? (0, timezone_1.almatyEndOfDay)(query.to) : (0, timezone_1.almatyNow)().endOf('day').toDate();
    const from = query.from ? (0, timezone_1.almatyStartOfDay)(query.from) : (0, dayjs_1.default)(to).tz(timezone_1.ALMATY_TZ).subtract(30, 'day').startOf('day').toDate();
    const marketplace = query.marketplace;
    return { from, to, marketplace };
}
// Канал APP (My Market) — налог ВСЕГДА 4%, независимо от общей настройки
// ставки налога (которая в Настройках может быть изменена для Kaspi/Ozon/
// WB) — это отдельный канал со своим фиксированным правилом, не "чужой %".
const APP_TAX_RATE_PCT = 4;
exports.analyticsRouter.get('/summary', async (req, res) => {
    const range = parseRange(req.query);
    const taxRatePct = range.marketplace === 'APP' ? APP_TAX_RATE_PCT : await (0, taxSettings_1.getTaxRatePct)();
    const summary = range.marketplace ? await (0, analytics_service_1.getSummary)(range, taxRatePct) : await (0, analytics_service_1.getSummaryByMarketplace)(range, taxRatePct);
    res.json(summary);
});
exports.analyticsRouter.get('/by-product', async (req, res) => {
    const range = parseRange(req.query);
    const taxRatePct = range.marketplace === 'APP' ? APP_TAX_RATE_PCT : await (0, taxSettings_1.getTaxRatePct)();
    const data = await (0, analytics_service_1.getByProduct)(range, taxRatePct);
    res.json(data);
});
exports.analyticsRouter.get('/by-category', async (req, res) => {
    const range = parseRange(req.query);
    const data = await (0, analytics_service_1.getByCategory)(range);
    res.json(data);
});
exports.analyticsRouter.get('/timeseries', async (req, res) => {
    const range = parseRange(req.query);
    const groupBy = req.query.groupBy || 'day';
    const data = await (0, analytics_service_1.getTimeseries)(range, groupBy);
    res.json(data);
});
/**
 * Прогнозная юнит-экономика по каталогу — не зависит от периода/фильтра
 * дат (это оценка "сейчас", а не отчёт за период) — см. analytics.service.ts.
 */
exports.analyticsRouter.get('/forecast', async (_req, res) => {
    const taxRatePct = await (0, taxSettings_1.getTaxRatePct)();
    const data = await (0, analytics_service_1.getProductForecasts)(taxRatePct);
    res.json(data);
});
//# sourceMappingURL=analytics.routes.js.map