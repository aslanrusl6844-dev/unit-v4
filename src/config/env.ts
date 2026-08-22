import 'dotenv/config';
import { z } from 'zod';

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
function cleanEnvString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted === '' ? undefined : unquoted;
  }
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Список допустимых значений зоны доставки — задан как константа с
 * "as const", чтобы TypeScript видел точный список ('city' | 'kazakhstan' |
 * 'express'), а не просто "string". Это важно: значение потом передаётся
 * в calculateKaspiDeliveryCost(), которая принимает именно эти три строки,
 * а не произвольную строку.
 */
const KASPI_DELIVERY_ZONES = ['city', 'kazakhstan', 'express'] as const;

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
  // Мягкая проверка (preprocess чистит строку + .catch() вместо .default()) —
  // опечатка или лишний пробел в панели Vercel не должны ронять весь сервер.
  KASPI_DEFAULT_DELIVERY_ZONE: z.preprocess((val) => {
    const cleaned = cleanEnvString(val);
    return typeof cleaned === 'string' ? cleaned.toLowerCase() : cleaned;
  }, z.enum(KASPI_DELIVERY_ZONES).catch('kazakhstan')),

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
}

/**
 * КРИТИЧЕСКИ ВАЖНО для Vercel: этот файл импортируется почти всеми
 * остальными модулями (напрямую или транзитивно). Если здесь выбросить
 * исключение — оно происходит на этапе ЗАГРУЗКИ МОДУЛЯ, ДО того, как
 * успевает сработать хоть один try/catch внутри обработчика запроса.
 * Результат — не наш аккуратный JSON с текстом ошибки, а голый крах всей
 * функции (Vercel показывает "500: FUNCTION_INVOCATION_FAILED" без
 * единой зацепки, и это касается АБСОЛЮТНО ВСЕХ страниц сайта, а не
 * только той, что реально использует базу).
 *
 * Поэтому вместо throw — мягкий fallback. Если DATABASE_URL действительно
 * не задан, prisma.ts откажется подключаться при первом реальном запросе
 * к базе — и это уже будет ПОЙМАНО существующими try/catch в роутах,
 * с понятным сообщением, а не крахом всего сайта.
 */
const databaseUrl = parsed.success ? parsed.data.DATABASE_URL : (process.env.DATABASE_URL ?? '');
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.error(
    '⚠️ DATABASE_URL не задан или пуст. Сайт запустится, но любой запрос к базе данных вернёт понятную ' +
      'ошибку вместо краха. Проверьте Environment Variables в Vercel — переменная должна быть включена ' +
      'для нужного окружения (Production/Preview/Development).',
  );
}

// Для остальных полей — то же самое: если что-то совсем не распарсилось,
// подстраховываемся разумными дефолтами, а не падаем.
const safeData: Partial<z.infer<typeof envSchema>> = parsed.success ? parsed.data : envSchema.partial().parse({});

export const env = {
  port: Number(safeData.PORT ?? '3000'),
  nodeEnv: safeData.NODE_ENV ?? 'development',
  databaseUrl,

  kaspi: {
    token: safeData.KASPI_API_TOKEN ?? '',
    merchantUid: safeData.KASPI_MERCHANT_UID ?? '',
    baseUrl: safeData.KASPI_API_BASE_URL ?? 'https://kaspi.kz/shop/api/v2',
    isConfigured: Boolean(safeData.KASPI_API_TOKEN),
    defaultDeliveryZone: safeData.KASPI_DEFAULT_DELIVERY_ZONE ?? 'kazakhstan',
  },

  ozon: {
    clientId: safeData.OZON_CLIENT_ID ?? '',
    apiKey: safeData.OZON_API_KEY ?? '',
    baseUrl: safeData.OZON_API_BASE_URL ?? 'https://api-seller.ozon.ru',
    isConfigured: Boolean(safeData.OZON_CLIENT_ID && safeData.OZON_API_KEY),
  },

  wb: {
    apiToken: safeData.WB_API_TOKEN ?? '',
    statsBaseUrl: safeData.WB_STATS_API_BASE_URL ?? 'https://statistics-api.wildberries.ru',
    isConfigured: Boolean(safeData.WB_API_TOKEN),
  },

  sync: {
    cron: safeData.SYNC_CRON ?? '*/30 * * * *',
    initialLookbackDays: Number(safeData.SYNC_INITIAL_LOOKBACK_DAYS ?? '30'),
  },

  repricerCron: safeData.REPRICER_CRON ?? '*/15 * * * *',
  priceFeedSecret: safeData.PRICE_FEED_SECRET ?? '',
};
