-- Озон-менеджер: история диалога бота
CREATE TABLE "OzonBotMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OzonBotMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OzonBotMessage_chatId_createdAt_idx" ON "OzonBotMessage"("chatId", "createdAt");
