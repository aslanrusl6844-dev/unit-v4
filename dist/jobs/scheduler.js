"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startScheduler = startScheduler;
exports.runInitialSyncIfNeeded = runInitialSyncIfNeeded;
const node_cron_1 = __importDefault(require("node-cron"));
const dayjs_1 = __importDefault(require("dayjs"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const sync_service_1 = require("../services/sync.service");
const repricer_service_1 = require("../services/repricer.service");
/**
 * Регулярная синхронизация заказов из Kaspi и Ozon.
 * Интервал задаётся SYNC_CRON в .env (по умолчанию каждые 30 минут).
 * Подтягивается "нахлёстом" последние 3 дня, чтобы подхватить изменения
 * статусов/комиссий по уже созданным заказам.
 */
function startScheduler() {
    if (!node_cron_1.default.validate(env_1.env.sync.cron)) {
        logger_1.logger.error(`Некорректное cron-выражение SYNC_CRON: ${env_1.env.sync.cron}`);
        return;
    }
    node_cron_1.default.schedule(env_1.env.sync.cron, async () => {
        const dateTo = new Date();
        const dateFrom = (0, dayjs_1.default)(dateTo).subtract(3, 'day').toDate();
        logger_1.logger.info('⏱ Запуск плановой синхронизации заказов...');
        try {
            const [kaspiResult, ozonResult, wbResult] = await Promise.allSettled([
                (0, sync_service_1.syncKaspiOrders)(dateFrom, dateTo),
                (0, sync_service_1.syncOzonOrders)(dateFrom, dateTo),
                (0, sync_service_1.syncWbOrders)(dateFrom, dateTo),
            ]);
            logger_1.logger.info({ kaspiResult, ozonResult, wbResult }, 'Плановая синхронизация завершена');
        }
        catch (err) {
            logger_1.logger.error({ err }, 'Ошибка плановой синхронизации');
        }
    });
    logger_1.logger.info(`🕒 Планировщик синхронизации запущен: "${env_1.env.sync.cron}"`);
    if (!node_cron_1.default.validate(env_1.env.repricerCron)) {
        logger_1.logger.error(`Некорректное cron-выражение REPRICER_CRON: ${env_1.env.repricerCron}`);
        return;
    }
    node_cron_1.default.schedule(env_1.env.repricerCron, async () => {
        logger_1.logger.info('💰 Запуск автобота пересчёта цен...');
        try {
            const results = await (0, repricer_service_1.runRepricingCycle)();
            const changed = results.filter((r) => r.changed).length;
            logger_1.logger.info(`Автобот цен: проверено ${results.length}, изменено ${changed}`);
        }
        catch (err) {
            logger_1.logger.error({ err }, 'Ошибка автобота пересчёта цен');
        }
    });
    logger_1.logger.info(`🕒 Автобот снижения цены запущен: "${env_1.env.repricerCron}"`);
}
async function runInitialSyncIfNeeded() {
    const dateTo = new Date();
    const dateFrom = (0, dayjs_1.default)(dateTo).subtract(env_1.env.sync.initialLookbackDays, 'day').toDate();
    logger_1.logger.info(`Первичная загрузка заказов за последние ${env_1.env.sync.initialLookbackDays} дн...`);
    const [kaspiResult, ozonResult, wbResult] = await Promise.allSettled([
        (0, sync_service_1.syncKaspiOrders)(dateFrom, dateTo),
        (0, sync_service_1.syncOzonOrders)(dateFrom, dateTo),
        (0, sync_service_1.syncWbOrders)(dateFrom, dateTo),
    ]);
    logger_1.logger.info({ kaspiResult, ozonResult, wbResult }, 'Первичная загрузка завершена');
}
//# sourceMappingURL=scheduler.js.map