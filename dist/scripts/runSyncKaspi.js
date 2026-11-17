"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dayjs_1 = __importDefault(require("dayjs"));
const sync_service_1 = require("../services/sync.service");
const logger_1 = require("../utils/logger");
const days = Number(process.argv[2]) || 30;
const dateTo = new Date();
const dateFrom = (0, dayjs_1.default)(dateTo).subtract(days, 'day').toDate();
(0, sync_service_1.syncKaspiOrders)(dateFrom, dateTo)
    .then((r) => {
    logger_1.logger.info(r, 'Синхронизация Kaspi завершена');
    process.exit(0);
})
    .catch((err) => {
    logger_1.logger.error({ err }, 'Синхронизация Kaspi упала с ошибкой');
    process.exit(1);
});
//# sourceMappingURL=runSyncKaspi.js.map