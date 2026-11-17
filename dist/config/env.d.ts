import 'dotenv/config';
/**
 * Убирает лишние пробелы/переносы строк и обрамляющие кавычки — частая
 * причина странных ошибок валидации, когда переменную окружения копируют
 * из другого места (Vercel Dashboard, .env файл с кавычками и т.п.).
 *
 * ВАЖНО: если после очистки строка стала ПУСТОЙ — возвращаем undefined,
 * а не ''. Иначе для полей с z.string().default('какое-то значение')
 * дефолт сработает только когда переменная вообще ОТСУТСТВУЕТ, но не
 * когда она явно задана пустой строкой (например, кто-то добавил
 * переменную в Vercel и оставил значение пустым) — и тогда вместо
 * дефолта (например, базового URL Kaspi API) получится '', из-за чего
 * запросы к API падают с "Invalid URL".
 */
/** Публичный адрес бакета R2: добавляет https://, если его нет, и убирает «/» в конце. */
export declare function normalizePublicUrl(raw: string): string;
export declare const env: {
    firebaseKey: string;
    port: number;
    nodeEnv: string;
    databaseUrl: string;
    kaspi: {
        token: string;
        merchantUid: string;
        baseUrl: string;
        isConfigured: boolean;
        defaultDeliveryZone: "city" | "kazakhstan" | "express";
    };
    ozon: {
        clientId: string;
        apiKey: string;
        baseUrl: string;
        isConfigured: boolean;
    };
    wb: {
        apiToken: string;
        statsBaseUrl: string;
        contentBaseUrl: string;
        pricesBaseUrl: string;
        financeBaseUrl: string;
        isConfigured: boolean;
    };
    teez: {
        baseUrl: string;
    };
    sync: {
        cron: string;
        initialLookbackDays: number;
    };
    repricerCron: string;
    priceFeedSecret: string;
    shopAppKey: string;
    blobToken: string;
    r2: {
        accountId: string;
        accessKeyId: string;
        secretAccessKey: string;
        bucket: string;
        publicUrl: string;
    };
    smsProvider: string;
    smsApiKey: string;
    telegramBotToken: string;
    telegramChatIds: string;
};
