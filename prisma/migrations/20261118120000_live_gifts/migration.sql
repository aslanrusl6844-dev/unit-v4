-- AlterTable
ALTER TABLE "Creator" ADD COLUMN "avatarUrl" TEXT;

-- AlterTable
ALTER TABLE "LiveChatMessage" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text',
ADD COLUMN "meta" TEXT;

-- CreateTable
CREATE TABLE "LiveGift" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '🎁',
    "imageUrl" TEXT,
    "coins" INTEGER NOT NULL DEFAULT 1,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveGift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveGiftSend" (
    "id" SERIAL NOT NULL,
    "streamId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "giftId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "coins" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveGiftSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveGiftSend_streamId_idx" ON "LiveGiftSend"("streamId");

-- CreateIndex
CREATE INDEX "LiveGiftSend_creatorId_idx" ON "LiveGiftSend"("creatorId");

-- CreateIndex
CREATE INDEX "LiveGiftSend_deviceKey_createdAt_idx" ON "LiveGiftSend"("deviceKey", "createdAt");
