-- Бегущая строка витрины: текст и два цвета (все поля необязательные).
ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "tickerText" TEXT;
ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "tickerBg" TEXT;
ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "tickerColor" TEXT;
