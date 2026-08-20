import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string(),

  KASPI_API_TOKEN: z.string().optional().default(''),
  KASPI_MERCHANT_UID: z.string().optional().default(''),
  KASPI_API_BASE_URL: z.string().default('https://kaspi.kz/shop/api/v2'),
  // Зона по умолчанию для расчёта тарифа Kaspi Доставки, если у заказа
  // нет более точных данных о том, доставлялся ли он по городу продавца,
  // по остальному Казахстану или экспрессом: 'city' | 'kazakhstan' | 'express'
  KASPI_DEFAULT_DELIVERY_ZONE: z.enum(['city', 'kazakhstan', 'express']).default('kazakhstan'),

  OZON_CLIENT_ID: z.string().optional().default(''),
  OZON_API_KEY: z.string().optional().default(''),
  OZON_API_BASE_URL: z.string().default('https://api-seller.ozon.ru'),

  WB_API_TOKEN: z.string().optional().default(''),
  WB_STATS_API_BASE_URL: z.string().default('https://statistics-api.wildberries.ru'),

  SYNC_CRON: z.string().default('*/30 * * * *'),
  SYNC_INITIAL_LOOKBACK_DAYS: z.string().default('30'),

  // Автобот снижения цены на Kaspi
  REPRICER_CRON: z.string().default('*/15 * * * *'),
  PRICE_FEED_SECRET: z.string().optional().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Ошибка конфигурации .env:', parsed.error.flatten().fieldErrors);
  process.exit(1);
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
