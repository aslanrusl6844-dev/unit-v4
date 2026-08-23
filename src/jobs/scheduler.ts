import cron from 'node-cron';
import dayjs from 'dayjs';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { syncKaspiOrders, syncOzonOrders, syncWbOrders } from '../services/sync.service';
import { runRepricingCycle } from '../services/repricer.service';

/**
 * Регулярная синхронизация заказов из Kaspi и Ozon.
 * Интервал задаётся SYNC_CRON в .env (по умолчанию каждые 30 минут).
 * Подтягивается "нахлёстом" последние 3 дня, чтобы подхватить изменения
 * статусов/комиссий по уже созданным заказам.
 */
export function startScheduler() {
  if (!cron.validate(env.sync.cron)) {
    logger.error(`Некорректное cron-выражение SYNC_CRON: ${env.sync.cron}`);
    return;
  }

  cron.schedule(env.sync.cron, async () => {
    const dateTo = new Date();
    const dateFrom = dayjs(dateTo).subtract(3, 'day').toDate();

    logger.info('⏱ Запуск плановой синхронизации заказов...');
    try {
      const [kaspiResult, ozonResult, wbResult] = await Promise.allSettled([
        syncKaspiOrders(dateFrom, dateTo),
        syncOzonOrders(dateFrom, dateTo),
        syncWbOrders(dateFrom, dateTo),
      ]);
      logger.info({ kaspiResult, ozonResult, wbResult }, 'Плановая синхронизация завершена');
    } catch (err) {
      logger.error({ err }, 'Ошибка плановой синхронизации');
    }
  });

  logger.info(`🕒 Планировщик синхронизации запущен: "${env.sync.cron}"`);

  if (!cron.validate(env.repricerCron)) {
    logger.error(`Некорректное cron-выражение REPRICER_CRON: ${env.repricerCron}`);
    return;
  }

  cron.schedule(env.repricerCron, async () => {
    logger.info('💰 Запуск автобота пересчёта цен...');
    try {
      const results = await runRepricingCycle();
      const changed = results.filter((r) => r.changed).length;
      logger.info(`Автобот цен: проверено ${results.length}, изменено ${changed}`);
    } catch (err) {
      logger.error({ err }, 'Ошибка автобота пересчёта цен');
    }
  });

  logger.info(`🕒 Автобот снижения цены запущен: "${env.repricerCron}"`);
}

export async function runInitialSyncIfNeeded() {
  const dateTo = new Date();
  const dateFrom = dayjs(dateTo).subtract(env.sync.initialLookbackDays, 'day').toDate();

  logger.info(`Первичная загрузка заказов за последние ${env.sync.initialLookbackDays} дн...`);
  const [kaspiResult, ozonResult, wbResult] = await Promise.allSettled([
    syncKaspiOrders(dateFrom, dateTo),
    syncOzonOrders(dateFrom, dateTo),
    syncWbOrders(dateFrom, dateTo),
  ]);
  logger.info({ kaspiResult, ozonResult, wbResult }, 'Первичная загрузка завершена');
}
