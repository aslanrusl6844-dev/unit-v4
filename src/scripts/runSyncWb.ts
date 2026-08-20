import dayjs from 'dayjs';
import { syncWbOrders } from '@/services/sync.service';
import { logger } from '@/utils/logger';

const days = Number(process.argv[2]) || 30;
const dateTo = new Date();
const dateFrom = dayjs(dateTo).subtract(days, 'day').toDate();

syncWbOrders(dateFrom, dateTo)
  .then((r) => {
    logger.info(r, 'Синхронизация Wildberries завершена');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'Синхронизация Wildberries упала с ошибкой');
    process.exit(1);
  });
