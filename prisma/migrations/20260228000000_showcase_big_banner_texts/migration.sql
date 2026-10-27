-- Витрины: текст и цвет текста для каждого баннера большой карусели (в том же порядке,
-- что и "bigBanners"). Только добавление колонок; у существующих витрин массивы пустые —
-- баннеры работают как раньше (без текста, цвет по умолчанию белый).
-- Идемпотентно: повторный запуск безопасен.

ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "bigBannerTexts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "bigBannerTextColors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
