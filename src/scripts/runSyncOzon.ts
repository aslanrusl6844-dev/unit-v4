import dayjs from 'dayjs';
import { syncOzonOrders } from '@/services/sync.service';
import { logger } from '@/utils/logger';

const days = Number(process.argv[2]) || 30;
const dateTo = new Date();
const dateFrom = dayjs(dateTo).subtract(days, 'day').toDate();

syncOzonOrders(dateFrom, dateTo)
  .then((r) => {
    logger.info(r, 'Синхронизация Ozon завершена');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'Синхронизация Ozon упала с ошибкой');
    process.exit(1);
  });
