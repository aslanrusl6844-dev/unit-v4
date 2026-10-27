-- Витрины: большая карусель баннеров сверху (до 10 URL). Только добавление колонки;
-- у существующих витрин bigBanners = пустой массив, они продолжают показывать bannerUrl.
-- Идемпотентно: повторный запуск безопасен.

ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "bigBanners" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
