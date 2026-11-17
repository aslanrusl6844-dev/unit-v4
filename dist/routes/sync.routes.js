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
exports.syncRouter = void 0;
const express_1 = require("express");
const dayjs_1 = __importDefault(require("dayjs"));
const prisma_1 = require("../db/prisma");
const teezSync_service_1 = require("../services/teezSync.service");
const teez_client_1 = require("../integrations/teez.client");
const sync_service_1 = require("../services/sync.service");
const kaspi_client_1 = require("../integrations/kaspi.client");
const ozon_client_1 = require("../integrations/ozon.client");
const wb_client_1 = require("../integrations/wb.client");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
exports.syncRouter = (0, express_1.Router)();
exports.syncRouter.post('/kaspi', async (req, res) => {
    const { dateFrom, dateTo } = resolveRange(req.query);
    try {
        const result = await (0, sync_service_1.syncKaspiOrders)(dateFrom, dateTo);
        res.json({ ok: true, ...result });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка ручной синхронизации Kaspi');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
/** Явные from/to (ISO-даты) — так фронтенд может сам резать большой период
 *  на маленькие куски и звать этот эндпоинт несколько раз подряд, вместо
 *  того чтобы просить сервер сделать всё за один HTTP-запрос (который на
 *  serverless легко упирается в лимит времени). Если from/to не переданы —
 *  используется старое поведение через ?days=N. */
function resolveRange(query) {
    if (query.from && query.to) {
        return { dateFrom: new Date(String(query.from)), dateTo: new Date(String(query.to)) };
    }
    const days = Number(query.days) || 7;
    const dateTo = new Date();
    const dateFrom = (0, dayjs_1.default)(dateTo).subtract(days, 'day').toDate();
    return { dateFrom, dateTo };
}
exports.syncRouter.post('/ozon', async (req, res) => {
    const { dateFrom, dateTo } = resolveRange(req.query);
    try {
        const result = await (0, sync_service_1.syncOzonOrders)(dateFrom, dateTo);
        res.json({ ok: true, ...result });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка ручной синхронизации Ozon');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
exports.syncRouter.post('/wb', async (req, res) => {
    const { dateFrom, dateTo } = resolveRange(req.query);
    try {
        const result = await (0, sync_service_1.syncWbOrders)(dateFrom, dateTo);
        res.json({ ok: true, ...result });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка ручной синхронизации Wildberries');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
exports.syncRouter.post('/teez', async (req, res) => {
    const { dateFrom, dateTo } = resolveRange(req.query);
    try {
        const result = await (0, teezSync_service_1.syncTeezOrders)(dateFrom, dateTo);
        res.json({ ok: true, ...result });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка ручной синхронизации Teez');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
/** Каталог Tez Market: товары, штрихкоды, цены, фото, остатки — в «Товары». */
exports.syncRouter.post('/teez-catalog', async (_req, res) => {
    try {
        res.json({ ok: true, ...(await (0, teezSync_service_1.syncTeezCatalog)()) });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка каталога Teez');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
/**
 * Синхронизация КАТАЛОГА (не заказов) — подтягивает список товаров,
 * СЕЙЧАС стоящих на продаже, через собственный API площадки. У Kaspi
 * такого метода нет (см. предупреждение в README и в разделе «Товары») —
 * поэтому эндпоинт есть только для Ozon и Wildberries.
 */
/** Только цены и тарифы Ozon (быстро) — для кнопки ↻ Ozon и автообновления. */
/** Начисления Ozon по заказам (комиссия, логистика, к выплате) — для ↻ Ozon и автообновления. */
exports.syncRouter.post('/ozon-accruals', async (req, res) => {
    try {
        const { refreshOzonAccruals } = await Promise.resolve().then(() => __importStar(require('../services/ozonPayouts.service')));
        res.json({ ok: true, ...(await refreshOzonAccruals({ force: req.query.force === '1' })) });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка начислений Ozon');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
exports.syncRouter.post('/ozon-prices', async (_req, res) => {
    try {
        res.json({ ok: true, ...(await (0, sync_service_1.syncOzonPrices)()) });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка обновления цен Ozon');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
/** Цены товара на Ozon прямо сейчас — для окна «Цена на Ozon» в админке. */
exports.syncRouter.get('/ozon-price/:productId', async (req, res) => {
    try {
        const p = await prisma_1.prisma.product.findUnique({ where: { id: req.params.productId }, select: { ozonOfferId: true } });
        if (!p?.ozonOfferId)
            return res.status(404).json({ error: 'У товара нет offer_id Ozon' });
        const d = await ozon_client_1.ozonClient.fetchPriceDetails(p.ozonOfferId);
        if (!d)
            return res.status(404).json({ error: 'Ozon не нашёл товар' });
        res.json(d);
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка чтения цены Ozon');
        res.status(500).json({ error: 'Не удалось получить цену с Ozon', details: String(err?.message ?? err) });
    }
});
/**
 * Поменять цену товара на Ozon: { price, oldPrice?, minPrice? }. Юнит-экономика считается
 * только от цены продажи (ozonReferencePrice) — её сразу записываем, дальше её уточнит
 * автосверка цен Ozon (каждые 5 минут, с учётом акций).
 */
exports.syncRouter.post('/ozon-price/:productId', async (req, res) => {
    const price = Number(req.body?.price);
    const oldPrice = req.body?.oldPrice == null || req.body.oldPrice === '' ? 0 : Number(req.body.oldPrice);
    const minPrice = req.body?.minPrice == null || req.body.minPrice === '' ? undefined : Number(req.body.minPrice);
    if (!Number.isFinite(price) || price <= 0)
        return res.status(400).json({ error: 'Укажите цену продажи больше 0' });
    if (!Number.isFinite(oldPrice) || oldPrice < 0)
        return res.status(400).json({ error: 'Старая цена — число от 0' });
    if (oldPrice > 0 && oldPrice <= price)
        return res.status(400).json({ error: 'Старая (зачёркнутая) цена должна быть больше цены продажи' });
    if (minPrice !== undefined && (!Number.isFinite(minPrice) || minPrice < 0))
        return res.status(400).json({ error: 'Минимальная цена — число от 0' });
    if (minPrice !== undefined && minPrice > price)
        return res.status(400).json({ error: 'Минимальная цена для акций не может быть больше цены продажи' });
    try {
        const p = await prisma_1.prisma.product.findUnique({ where: { id: req.params.productId }, select: { id: true, ozonOfferId: true, name: true } });
        if (!p?.ozonOfferId)
            return res.status(404).json({ error: 'У товара нет offer_id Ozon' });
        const current = await ozon_client_1.ozonClient.fetchPriceDetails(p.ozonOfferId).catch(() => null);
        const errors = await ozon_client_1.ozonClient.updatePrice({ offerId: p.ozonOfferId, price, oldPrice, minPrice, currency: current?.currency });
        if (errors.length)
            return res.status(422).json({ error: 'Ozon не принял цену', details: errors.join('; ') });
        await prisma_1.prisma.product.update({ where: { id: p.id }, data: { ozonReferencePrice: Math.round(price), ozonReferencePriceUpdatedAt: new Date() } });
        logger_1.logger.info({ offerId: p.ozonOfferId, price, oldPrice, minPrice }, '[Ozon] цена изменена из админки');
        res.json({ ok: true, price: Math.round(price), oldPrice: Math.round(oldPrice), minPrice: minPrice != null ? Math.round(minPrice) : null });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка смены цены Ozon');
        res.status(500).json({ error: 'Не удалось поменять цену на Ozon', details: String(err?.message ?? err) });
    }
});
exports.syncRouter.post('/ozon-catalog', async (_req, res) => {
    try {
        const result = await (0, sync_service_1.syncOzonCatalog)();
        res.json({ ok: true, ...result });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка синхронизации каталога Ozon');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
exports.syncRouter.post('/wb-catalog', async (_req, res) => {
    try {
        const result = await (0, sync_service_1.syncWbCatalog)();
        res.json({ ok: true, ...result });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка синхронизации каталога Wildberries');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
/**
 * Фото Kaspi для товаров учёта — пачкой по 5 (см. syncKaspiPhotos). Фронт
 * вызывает повторно, пока remaining не станет 0, передавая в excludeIds
 * товары, которые не удалось прочитать в этом запуске.
 */
exports.syncRouter.post('/kaspi-photos', async (req, res) => {
    try {
        const excludeIds = Array.isArray(req.body?.excludeIds)
            ? req.body.excludeIds.filter((x) => typeof x === 'string').slice(0, 500)
            : [];
        const result = await (0, sync_service_1.syncKaspiPhotos)(5, excludeIds);
        res.json({ ok: true, ...result });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка синхронизации фото Kaspi');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
/**
 * Описание/состав/фото/категория карточек My Market из Ozon — пачкой по 40
 * с курсором (см. syncOzonContent). Фронт вызывает повторно, пока done=false.
 */
exports.syncRouter.post('/ozon-content', async (req, res) => {
    try {
        const cursor = typeof req.body?.cursor === 'string' && req.body.cursor ? req.body.cursor : undefined;
        const result = await (0, sync_service_1.syncOzonContent)(40, cursor);
        res.json({ ok: true, ...result });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Ошибка синхронизации описаний Ozon');
        res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
});
exports.syncRouter.get('/logs', async (_req, res) => {
    const logs = await prisma_1.prisma.syncLog.findMany({ orderBy: { startedAt: 'desc' }, take: 30 });
    res.json(logs);
});
exports.syncRouter.get('/status', async (_req, res) => {
    res.json({
        kaspi: { configured: await kaspi_client_1.kaspiClient.isConfigured() },
        ozon: { configured: await ozon_client_1.ozonClient.isConfigured() },
        wb: { configured: await wb_client_1.wbClient.isConfigured() },
        teez: { configured: await teez_client_1.teezClient.isConfigured() },
        cron: env_1.env.sync.cron,
    });
});
//# sourceMappingURL=sync.routes.js.map