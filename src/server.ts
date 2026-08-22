import app from './expressApp';
import { env } from './config/env';
import { logger } from './utils/logger';
import { startScheduler } from './jobs/scheduler';

/**
 * Точка входа ТОЛЬКО для локальной разработки (npm run dev / npm start).
 * На Vercel этот файл не используется — там сервер живёт как serverless-
 * функция в api/[...slug].ts, а фоновые задачи (синхронизация, автобот
 * цены) запускаются по HTTP через /api/cron/* внешним расписанием, а не
 * через постоянно висящий процесс с node-cron (serverless-функции не
 * умеют держать процесс живым между запросами).
 */
app.listen(env.port, () => {
  logger.info(`🚀 Сервер юнит-экономики запущен: http://localhost:${env.port}`);
  logger.info(`   Kaspi API: ${env.kaspi.isConfigured ? 'настроен' : 'НЕ настроен (см. .env)'}`);
  logger.info(`   Ozon API:  ${env.ozon.isConfigured ? 'настроен' : 'НЕ настроен (см. .env)'}`);
  logger.info(`   WB API:    ${env.wb.isConfigured ? 'настроен' : 'НЕ настроен (см. .env)'}`);
  startScheduler();
});
