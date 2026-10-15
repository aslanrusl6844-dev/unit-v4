-- Витрины: несколько баннеров и ссылка на видео. Только добавление колонок в
-- таблицу Showcase (созданную миграцией 20260217000000_showcases); существующие
-- данные не меняются, у старых витрин banners = пустой массив, videoUrl = NULL.
-- Идемпотентно: повторный запуск безопасен.

ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "banners" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "videoUrl" TEXT;
