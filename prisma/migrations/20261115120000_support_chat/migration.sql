-- Чат с оператором из чата Баурсака (ответы через Telegram-бот)
CREATE TABLE "SupportChat" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "phone" TEXT,
    "customerName" TEXT,
    "pushToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "operatorName" TEXT,
    "operatorTgChatId" TEXT,
    "lastOperatorAt" TIMESTAMP(3),
    "lastCustomerAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    CONSTRAINT "SupportChat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupportChat_number_key" ON "SupportChat"("number");
CREATE INDEX "SupportChat_phone_idx" ON "SupportChat"("phone");
CREATE INDEX "SupportChat_status_idx" ON "SupportChat"("status");

CREATE TABLE "SupportMessage" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "operatorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupportMessage_chatId_id_idx" ON "SupportMessage"("chatId", "id");
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "SupportChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SupportTgRef" (
    "id" SERIAL NOT NULL,
    "supportChatId" TEXT NOT NULL,
    "tgChatId" TEXT NOT NULL,
    "tgMessageId" INTEGER NOT NULL,
    CONSTRAINT "SupportTgRef_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupportTgRef_tgChatId_tgMessageId_key" ON "SupportTgRef"("tgChatId", "tgMessageId");
CREATE INDEX "SupportTgRef_supportChatId_idx" ON "SupportTgRef"("supportChatId");
