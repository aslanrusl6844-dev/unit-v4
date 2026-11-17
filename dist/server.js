"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const expressApp_1 = __importDefault(require("./expressApp"));
const env_1 = require("./config/env");
const logger_1 = require("./utils/logger");
const scheduler_1 = require("./jobs/scheduler");
/**
 * Точка входа ТОЛЬКО для локальной разработки (npm run dev / npm start).
 * На Vercel этот файл не используется — там сервер живёт как serverless-
 * функция в api/[...slug].ts, а фоновые задачи (синхронизация, автобот
 * цены) запускаются по HTTP через /api/cron/* внешним расписанием, а не
 * через постоянно висящий процесс с node-cron (serverless-функции не
 * умеют держать процесс живым между запросами).
 */
expressApp_1.default.listen(env_1.env.port, () => {
    logger_1.logger.info(`🚀 Сервер юнит-экономики запущен: http://localhost:${env_1.env.port}`);
    logger_1.logger.info(`   Kaspi API: ${env_1.env.kaspi.isConfigured ? 'настроен' : 'НЕ настроен (см. .env)'}`);
    logger_1.logger.info(`   Ozon API:  ${env_1.env.ozon.isConfigured ? 'настроен' : 'НЕ настроен (см. .env)'}`);
    logger_1.logger.info(`   WB API:    ${env_1.env.wb.isConfigured ? 'настроен' : 'НЕ настроен (см. .env)'}`);
    (0, scheduler_1.startScheduler)();
});
//# sourceMappingURL=server.js.map