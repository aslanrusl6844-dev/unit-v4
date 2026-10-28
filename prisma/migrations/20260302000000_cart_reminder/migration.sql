-- Напоминание о корзине: журнал отправленных пушей (одно на событие «в корзину», не чаще раза в сутки на номер).
-- Только новая таблица; идемпотентно: повторный запуск безопасен.

CREATE TABLE IF NOT EXISTS "CartReminder" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CartReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CartReminder_eventId_key" ON "CartReminder"("eventId");
CREATE INDEX IF NOT EXISTS "CartReminder_phone_sentAt_idx" ON "CartReminder"("phone", "sentAt");
