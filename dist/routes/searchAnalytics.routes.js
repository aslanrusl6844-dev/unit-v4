"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchAnalyticsRouter = void 0;
const express_1 = require("express");
const dayjs_1 = __importDefault(require("dayjs"));
const zod_1 = require("zod");
const searchAnalytics_service_1 = require("../services/searchAnalytics.service");
const wordstat_service_1 = require("../services/wordstat.service");
const logger_1 = require("../utils/logger");
exports.searchAnalyticsRouter = (0, express_1.Router)();
const keywordSchema = zod_1.z.string().trim().min(2, 'Введите слово (минимум 2 символа)').max(80);
exports.searchAnalyticsRouter.get('/regions', (_req, res) => {
    res.json(Object.entries(searchAnalytics_service_1.TRENDS_REGIONS).map(([code, label]) => ({ code, label })));
});
/** Продажи своих товаров по слову: ?q=куртка&from=2026-01-01&to=2026-10-31 */
exports.searchAnalyticsRouter.get('/my-sales', async (req, res) => {
    const q = keywordSchema.safeParse(req.query.q);
    if (!q.success)
        return res.status(400).json({ error: q.error.issues[0].message });
    const to = req.query.to ? new Date(String(req.query.to) + 'T23:59:59') : new Date();
    const from = req.query.from ? new Date(String(req.query.from) + 'T00:00:00') : (0, dayjs_1.default)(to).subtract(11, 'month').startOf('month').toDate();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
        return res.status(400).json({ error: 'Неверная дата' });
    if ((0, dayjs_1.default)(to).diff(from, 'month') > 36)
        return res.status(400).json({ error: 'Период не больше 36 месяцев' });
    try {
        res.json(await (0, searchAnalytics_service_1.getMySalesByKeyword)(q.data, from, to));
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Аналитика запросов] Ошибка «Мои продажи»');
        res.status(500).json({ error: 'Не удалось посчитать продажи', details: String(err?.message ?? err) });
    }
});
/** Google Trends: ?q=куртка&geo=KZ-ALA&months=12 */
exports.searchAnalyticsRouter.get('/google-trends', async (req, res) => {
    const q = keywordSchema.safeParse(req.query.q);
    if (!q.success)
        return res.status(400).json({ error: q.error.issues[0].message });
    const geo = String(req.query.geo || 'KZ');
    if (!(geo in searchAnalytics_service_1.TRENDS_REGIONS))
        return res.status(400).json({ error: 'Неизвестный регион' });
    const months = Number(req.query.months) || 12;
    try {
        res.json(await (0, searchAnalytics_service_1.getGoogleTrends)(q.data, geo, months));
    }
    catch (err) {
        logger_1.logger.warn({ err }, '[Аналитика запросов] Google Trends недоступен');
        res.status(502).json({ error: 'Google Trends не ответил', details: String(err?.message ?? err) });
    }
});
/** Яндекс Wordstat: ?q=куртка&geo=KZ-ALA — топ запросов со словом (Yandex Search API). */
exports.searchAnalyticsRouter.get('/wordstat', async (req, res) => {
    const q = keywordSchema.safeParse(req.query.q);
    if (!q.success)
        return res.status(400).json({ error: q.error.issues[0].message });
    const geo = String(req.query.geo || 'KZ');
    if (!(geo in wordstat_service_1.WORDSTAT_REGIONS))
        return res.status(400).json({ error: 'Для Wordstat этот регион пока не подключён' });
    try {
        res.json(await (0, wordstat_service_1.getWordstatTop)(q.data, geo));
    }
    catch (err) {
        logger_1.logger.warn({ err }, '[Аналитика запросов] Wordstat недоступен');
        res.status(502).json({ error: 'Wordstat не ответил', details: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=searchAnalytics.routes.js.map