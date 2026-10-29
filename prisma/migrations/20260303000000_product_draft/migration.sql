-- Черновики товаров из Telegram-бота. Только новая таблица; идемпотентно.

CREATE TABLE IF NOT EXISTS "ProductDraft" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "price" DOUBLE PRECISION,
    "oldPrice" DOUBLE PRECISION,
    "notes" TEXT,
    "data" JSONB,
    "revisions" INTEGER NOT NULL DEFAULT 0,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProductDraft_chatId_status_idx" ON "ProductDraft"("chatId", "status");
