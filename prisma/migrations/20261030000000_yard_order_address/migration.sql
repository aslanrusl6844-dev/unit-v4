-- Адрес доставки заказа «Двора»: подъезд, этаж, квартира, домофон.
-- Только новые необязательные колонки; существующие данные не меняются. Идемпотентно.
ALTER TABLE "YardOrder" ADD COLUMN IF NOT EXISTS "entrance" TEXT;
ALTER TABLE "YardOrder" ADD COLUMN IF NOT EXISTS "floor" TEXT;
ALTER TABLE "YardOrder" ADD COLUMN IF NOT EXISTS "apartment" TEXT;
ALTER TABLE "YardOrder" ADD COLUMN IF NOT EXISTS "intercom" TEXT;
