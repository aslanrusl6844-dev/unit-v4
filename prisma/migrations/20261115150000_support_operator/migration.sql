-- Имя оператора чата поддержки (команда «/имя» в Telegram-боте)
CREATE TABLE "SupportOperator" (
    "tgUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupportOperator_pkey" PRIMARY KEY ("tgUserId")
);
