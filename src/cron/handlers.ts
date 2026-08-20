import dayjs from 'dayjs';
import { syncKaspiOrders, syncOzonOrders, syncWbOrders } from '@/services/sync.service';
import { runRepricingCycle } from '@/services/repricer.service';

/**
 * Синхронизация заказов по всем трём площадкам. Вызывается по HTTP из
 * api/[...slug].ts (эндпоинт /api/cron/sync) — расписание задаёт внешний
 * планировщик (Vercel Cron раз в сутки на бесплатном тарифе, и/или
 * бесплатный внешний сервис вроде cron-job.org для более частого запуска).
 */
export async function runOrderSync(lookbackDays = 3) {
  const dateTo = new Date();
  const dateFrom = dayjs(dateTo).subtract(lookbackDays, 'day').toDate();

  const [kaspi, ozon, wb] = await Promise.allSettled([
    syncKaspiOrders(dateFrom, dateTo),
    syncOzonOrders(dateFrom, dateTo),
    syncWbOrders(dateFrom, dateTo),
  ]);

  return { kaspi, ozon, wb };
}

/** Один цикл автобота снижения цены на Kaspi. */
export async function runReprice() {
  return runRepricingCycle();
}
