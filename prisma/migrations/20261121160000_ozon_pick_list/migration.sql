-- Озон-бот: пронумерованный список «что собрать/отгрузить» на чат; владелец присылает номера собранного — бот их вычёркивает.
CREATE TABLE IF NOT EXISTS "OzonBotPickList" (
  "chatId" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "items" TEXT NOT NULL DEFAULT '[]',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OzonBotPickList_pkey" PRIMARY KEY ("chatId")
);
