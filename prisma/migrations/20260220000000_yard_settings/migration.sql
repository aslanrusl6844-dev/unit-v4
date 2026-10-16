-- Двор: общие настройки (одна строка id = 'main'). Сейчас — ссылка на
-- видео-инструкцию для покупателей. Только новая таблица, существующие таблицы
-- и данные не меняются. Идемпотентно: повторный запуск безопасен.

CREATE TABLE IF NOT EXISTS "YardSettings" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "instructionUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "YardSettings_pkey" PRIMARY KEY ("id")
);
