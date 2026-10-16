-- Двор: радиус показа магазина, баннер, видео и бегущая строка. Только добавление
-- колонок в существующую таблицу YardShop: строки, заказы и товары не меняются.
-- Старые магазины получают radiusMeters = 500, остальные поля = NULL.
-- Идемпотентно: повторный запуск безопасен.

ALTER TABLE "YardShop" ADD COLUMN IF NOT EXISTS "radiusMeters" INTEGER NOT NULL DEFAULT 500;
ALTER TABLE "YardShop" ADD COLUMN IF NOT EXISTS "bannerUrl" TEXT;
ALTER TABLE "YardShop" ADD COLUMN IF NOT EXISTS "videoUrl" TEXT;
ALTER TABLE "YardShop" ADD COLUMN IF NOT EXISTS "tickerText" TEXT;
