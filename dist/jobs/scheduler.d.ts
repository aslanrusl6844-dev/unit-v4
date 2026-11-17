/**
 * Регулярная синхронизация заказов из Kaspi и Ozon.
 * Интервал задаётся SYNC_CRON в .env (по умолчанию каждые 30 минут).
 * Подтягивается "нахлёстом" последние 3 дня, чтобы подхватить изменения
 * статусов/комиссий по уже созданным заказам.
 */
export declare function startScheduler(): void;
export declare function runInitialSyncIfNeeded(): Promise<void>;
