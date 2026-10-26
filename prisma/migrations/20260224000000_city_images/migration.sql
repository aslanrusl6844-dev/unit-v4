-- Картинки городов (одна строка на город). Только новая таблица, существующие
-- таблицы и данные не меняются. Идемпотентно: повторный запуск безопасен.

CREATE TABLE IF NOT EXISTS "CityImage" (
    "city" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CityImage_pkey" PRIMARY KEY ("city")
);
