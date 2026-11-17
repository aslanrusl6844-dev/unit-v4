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
exports.runOrderSync = runOrderSync;
exports.runReprice = runReprice;
exports.runWarmup = runWarmup;
exports.runCartReminder = runCartReminder;
exports.runOzonPrices = runOzonPrices;
exports.runRekassaShiftClose = runRekassaShiftClose;
exports.runOzonBotReport = runOzonBotReport;
const dayjs_1 = __importDefault(require("dayjs"));
const sync_service_1 = require("../services/sync.service");
const repricer_service_1 = require("../services/repricer.service");
const prisma_1 = require("../db/prisma");
/**
 * Синхронизация заказов по всем трём площадкам. Вызывается по HTTP из
 * api/[...slug].ts (эндпоинт /api/cron/sync) — расписание задаёт внешний
 * планировщик (Vercel Cron раз в сутки на бесплатном тарифе, и/или
 * бесплатный внешний сервис вроде cron-job.org для более частого запуска).
 */
async function runOrderSync(lookbackDays = 3) {
    const dateTo = new Date();
    const dateFrom = (0, dayjs_1.default)(dateTo).subtract(lookbackDays, 'day').toDate();
    const [kaspi, ozon, wb] = await Promise.allSettled([
        (0, sync_service_1.syncKaspiOrders)(dateFrom, dateTo),
        (0, sync_service_1.syncOzonOrders)(dateFrom, dateTo),
        (0, sync_service_1.syncWbOrders)(dateFrom, dateTo),
    ]);
    return { kaspi, ozon, wb };
}
/** Один цикл автобота снижения цены на Kaspi. */
async function runReprice() {
    return (0, repricer_service_1.runRepricingCycle)();
}
/**
 * Лёгкий "пинг" базы данных — ничего полезного не делает, кроме одного
 * простого SELECT. Единственная цель: не дать бесплатной базе Neon
 * "заснуть" от простоя (autosuspend через ~5 минут бездействия). Первый
 * запрос после засыпания просыпается несколько секунд — вместе с холодным
 * стартом самой функции Vercel это может привести к таймауту 504.
 * Настройте внешний планировщик (cron-job.org) дёргать этот эндпоинт
 * каждые 4 минуты — см. README.
 */
async function runWarmup() {
    const startedAt = Date.now();
    await prisma_1.prisma.$queryRaw `SELECT 1`;
    return { ok: true, ms: Date.now() - startedAt };
}
/** Напоминания о корзине (товар в корзине > 24 ч, заказа нет). */
async function runCartReminder() {
    const { runCartReminders } = await Promise.resolve().then(() => __importStar(require('../services/cartReminder.service')));
    return runCartReminders();
}
/** Живые цены Ozon (с учётом акций) — каждые 5 минут, см. .github/workflows/ozon-prices.yml. */
async function runOzonPrices() {
    const prices = await (0, sync_service_1.syncOzonPrices)();
    // Заодно начисления Ozon по заказам — сама функция ходит в Ozon не чаще раза в 20 минут.
    let accruals = null;
    try {
        const { refreshOzonAccruals } = await Promise.resolve().then(() => __importStar(require('../services/ozonPayouts.service')));
        accruals = await refreshOzonAccruals();
    }
    catch (err) {
        accruals = { error: String(err?.message ?? err) };
    }
    return { prices, accruals };
}
/** Раз в сутки закрыть смену онлайн-кассы re:Kassa (смена не может жить больше 24 ч). */
async function runRekassaShiftClose() {
    const { closeRekassaShift } = await Promise.resolve().then(() => __importStar(require('../services/rekassa.service')));
    return closeRekassaShift();
}
/** Озон-менеджер: утренний / вечерний отчёт владельцу в Telegram. */
async function runOzonBotReport(kind) {
    const { sendOzonBotReport } = await Promise.resolve().then(() => __importStar(require('../routes/ozonBot.routes')));
    return sendOzonBotReport(kind);
}
//# sourceMappingURL=handlers.js.map