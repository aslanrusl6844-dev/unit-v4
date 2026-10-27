-- До трёх видео (URL) у товара и у витрины. Только добавление колонок; существующие
-- записи не меняются, у них videos = пустой массив. Идемпотентно: повторный запуск безопасен.

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "videos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "videos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
