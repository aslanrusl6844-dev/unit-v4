-- Витрины: начертание текста (normal | bold | large) для каждого баннера большой карусели,
-- в том же порядке, что "bigBanners". Только добавление колонки; у существующих витрин массив
-- пустой — шрифт обычный. Идемпотентно: повторный запуск безопасен.

ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "bigBannerFontStyles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
