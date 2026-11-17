/**
 * Синхронизация заказов по всем трём площадкам. Вызывается по HTTP из
 * api/[...slug].ts (эндпоинт /api/cron/sync) — расписание задаёт внешний
 * планировщик (Vercel Cron раз в сутки на бесплатном тарифе, и/или
 * бесплатный внешний сервис вроде cron-job.org для более частого запуска).
 */
export declare function runOrderSync(lookbackDays?: number): Promise<{
    kaspi: PromiseSettledResult<{
        ordersProcessed: number;
        productsCreated: number;
    }>;
    ozon: PromiseSettledResult<{
        ordersProcessed: number;
        productsCreated: number;
    }>;
    wb: PromiseSettledResult<{
        ordersProcessed: number;
        productsCreated: number;
    }>;
}>;
/** Один цикл автобота снижения цены на Kaspi. */
export declare function runReprice(): Promise<import("../services/repricer.service").RepriceResult[]>;
/**
 * Лёгкий "пинг" базы данных — ничего полезного не делает, кроме одного
 * простого SELECT. Единственная цель: не дать бесплатной базе Neon
 * "заснуть" от простоя (autosuspend через ~5 минут бездействия). Первый
 * запрос после засыпания просыпается несколько секунд — вместе с холодным
 * стартом самой функции Vercel это может привести к таймауту 504.
 * Настройте внешний планировщик (cron-job.org) дёргать этот эндпоинт
 * каждые 4 минуты — см. README.
 */
export declare function runWarmup(): Promise<{
    ok: boolean;
    ms: number;
}>;
/** Напоминания о корзине (товар в корзине > 24 ч, заказа нет). */
export declare function runCartReminder(): Promise<import("../services/cartReminder.service").CartReminderResult>;
/** Живые цены Ozon (с учётом акций) — каждые 5 минут, см. .github/workflows/ozon-prices.yml. */
export declare function runOzonPrices(): Promise<{
    prices: {
        updated: number;
        skipped: "not-configured";
        total?: undefined;
        inActions?: undefined;
    } | {
        updated: number;
        total: number;
        inActions: number;
        skipped?: undefined;
    };
    accruals: unknown;
}>;
/** Раз в сутки закрыть смену онлайн-кассы re:Kassa (смена не может жить больше 24 ч). */
export declare function runRekassaShiftClose(): Promise<{
    closed: boolean;
    shiftNumber?: number;
    reason?: string;
}>;
/** Озон-менеджер: утренний / вечерний отчёт владельцу в Telegram. */
export declare function runOzonBotReport(kind: 'morning' | 'evening'): Promise<{
    sent: boolean;
    reason?: string;
}>;
