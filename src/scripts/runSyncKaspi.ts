import dayjs from 'dayjs';
import { syncKaspiOrders } from '../services/sync.service';
import { logger } from '../utils/logger';

const days = Number(process.argv[2]) || 30;
const dateTo = new Date();
const dateFrom = dayjs(dateTo).subtract(days, 'day').toDate();

syncKaspiOrders(dateFrom, dateTo)
  .then((r) => {
    logger.info(r, 'Синхронизация Kaspi завершена');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'Синхронизация Kaspi упала с ошибкой');
    process.exit(1);
  });
