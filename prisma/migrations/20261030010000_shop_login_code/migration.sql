-- Код входа покупателя (хэш, срок, число попыток)
CREATE TABLE IF NOT EXISTS "ShopLoginCode" (
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopLoginCode_pkey" PRIMARY KEY ("phone")
);
