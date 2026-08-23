import dayjs from 'dayjs';
import { syncKaspiOrders, syncOzonOrders, syncWbOrders } from '../services/sync.service';
import { runRepricingCycle } from '../services/repricer.service';
import { prisma } from '../db/prisma';

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

/**
 * Лёгкий "пинг" базы данных — ничего полезного не делает, кроме одного
 * простого SELECT. Единственная цель: не дать бесплатной базе Neon
 * "заснуть" от простоя (autosuspend через ~5 минут бездействия). Первый
 * запрос после засыпания просыпается несколько секунд — вместе с холодным
 * стартом самой функции Vercel это может привести к таймауту 504.
 * Настройте внешний планировщик (cron-job.org) дёргать этот эндпоинт
 * каждые 4 минуты — см. README.
 */
export async function runWarmup() {
  const startedAt = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  return { ok: true, ms: Date.now() - startedAt };
}
