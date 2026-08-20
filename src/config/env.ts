import 'dotenv/config';
import { z } from 'zod';

/**
 * Убирает лишние пробелы/переносы строк и обрамляющие кавычки — частая
 * причина странных ошибок валидации, когда переменную окружения копируют
 * из другого места (Vercel Dashboard, .env файл с кавычками и т.п.).
 */
function cleanEnvString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Enum-поле, которое НИКОГДА не рушит всю сборку .env: если значение
 * отсутствует, пустое, с опечаткой или в неправильном регистре — тихо
 * откатывается на значение по умолчанию вместо жёсткой ошибки.
 * Это осознанный компромисс для некритичных настроек (типа зоны доставки):
 * лучше сервер поработает с разумным значением по умолчанию, чем упадёт
 * целиком из-за одной опечатки в панели Vercel.
 */
function softEnum<T extends [string, ...string[]]>(values: T, fallback: T[number]) {
  return z.preprocess((val) => {
    const cleaned = cleanEnvString(val);
    return typeof cleaned === 'string' ? cleaned.toLowerCase() : cleaned;
  }, z.enum(values).catch(fallback));
}

const envSchema = z.object({
  PORT: z.preprocess(cleanEnvString, z.string().default('3000')),
  NODE_ENV: z.preprocess(cleanEnvString, z.string().default('development')),
  // DATABASE_URL по-настоящему обязателен — без него сервер физически не
  // может работать (это не Zod-проверка, Prisma сам откажется подключаться).
  DATABASE_URL: z.preprocess(cleanEnvString, z.string().min(1, 'DATABASE_URL не задан')),

  KASPI_API_TOKEN: z.preprocess(cleanEnvString, z.string().optional().default('')),
  KASPI_MERCHANT_UID: z.preprocess(cleanEnvString, z.string().optional().default('')),
  KASPI_API_BASE_URL: z.preprocess(cleanEnvString, z.string().default('https://kaspi.kz/shop/api/v2')),
  // Зона по умолчанию для расчёта тарифа Kaspi Доставки: 'city' | 'kazakhstan' | 'express'.
  // Мягкая проверка — опечатка здесь не должна ронять весь сервер.
  KASPI_DEFAULT_DELIVERY_ZONE: softEnum(['city', 'kazakhstan', 'express'], 'kazakhstan'),

  OZON_CLIENT_ID: z.preprocess(cleanEnvString, z.string().optional().default('')),
  OZON_API_KEY: z.preprocess(cleanEnvString, z.string().optional().default('')),
  OZON_API_BASE_URL: z.preprocess(cleanEnvString, z.string().default('https://api-seller.ozon.ru')),

  WB_API_TOKEN: z.preprocess(cleanEnvString, z.string().optional().default('')),
  WB_STATS_API_BASE_URL: z.preprocess(cleanEnvString, z.string().default('https://statistics-api.wildberries.ru')),

  SYNC_CRON: z.preprocess(cleanEnvString, z.string().default('*/30 * * * *')),
  SYNC_INITIAL_LOOKBACK_DAYS: z.preprocess(cleanEnvString, z.string().default('30')),

  // Автобот снижения цены на Kaspi
  REPRICER_CRON: z.preprocess(cleanEnvString, z.string().default('*/15 * * * *')),
  PRICE_FEED_SECRET: z.preprocess(cleanEnvString, z.string().optional().default('')),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.flatten().fieldErrors;
  // eslint-disable-next-line no-console
  console.error('Ошибка конфигурации .env:', details);
  // ВАЖНО: на Vercel (serverless) НЕЛЬЗЯ вызывать process.exit() — это не
  // "перезапускает" функцию, а ломает рантайм для всех последующих
  // запросов до нового деплоя. Вместо этого кидаем обычную ошибку — её
  // поймает обработчик ошибок Express и вернёт понятный 500 с текстом,
  // вместо необъяснимого падения всего сервера.
  throw new Error(
    `Ошибка конфигурации .env: ${JSON.stringify(details)}. Проверьте переменные окружения в настройках проекта.`,
  );
}

export const env = {
  port: Number(parsed.data.PORT),
  nodeEnv: parsed.data.NODE_ENV,
  databaseUrl: parsed.data.DATABASE_URL,

  kaspi: {
    token: parsed.data.KASPI_API_TOKEN,
    merchantUid: parsed.data.KASPI_MERCHANT_UID,
    baseUrl: parsed.data.KASPI_API_BASE_URL,
    isConfigured: Boolean(parsed.data.KASPI_API_TOKEN),
    defaultDeliveryZone: parsed.data.KASPI_DEFAULT_DELIVERY_ZONE,
  },

  ozon: {
    clientId: parsed.data.OZON_CLIENT_ID,
    apiKey: parsed.data.OZON_API_KEY,
    baseUrl: parsed.data.OZON_API_BASE_URL,
    isConfigured: Boolean(parsed.data.OZON_CLIENT_ID && parsed.data.OZON_API_KEY),
  },

  wb: {
    apiToken: parsed.data.WB_API_TOKEN,
    statsBaseUrl: parsed.data.WB_STATS_API_BASE_URL,
    isConfigured: Boolean(parsed.data.WB_API_TOKEN),
  },

  sync: {
    cron: parsed.data.SYNC_CRON,
    initialLookbackDays: Number(parsed.data.SYNC_INITIAL_LOOKBACK_DAYS),
  },

  repricerCron: parsed.data.REPRICER_CRON,
  priceFeedSecret: parsed.data.PRICE_FEED_SECRET,
};
