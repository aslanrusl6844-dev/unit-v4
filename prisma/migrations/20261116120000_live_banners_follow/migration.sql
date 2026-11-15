-- Баннеры Live и подписка «сообщить о следующем эфире»
CREATE TABLE "LiveBanner" (
    "id" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "title" TEXT,
    "linkType" TEXT NOT NULL DEFAULT '',
    "linkValue" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LiveBanner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveFollow" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "phone" TEXT,
    "pushToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveFollow_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LiveFollow_creatorId_deviceKey_key" ON "LiveFollow"("creatorId", "deviceKey");
CREATE INDEX "LiveFollow_creatorId_idx" ON "LiveFollow"("creatorId");
