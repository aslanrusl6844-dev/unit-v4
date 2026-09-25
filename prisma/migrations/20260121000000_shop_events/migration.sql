-- CreateEnum
CREATE TYPE "ShopEventType" AS ENUM ('search', 'view', 'cart', 'order', 'paid');

-- CreateTable
CREATE TABLE "ShopEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "ShopEventType" NOT NULL,
    "query" TEXT,
    "sku" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "resultsCount" INTEGER,
    "amount" INTEGER,

    CONSTRAINT "ShopEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopEvent_createdAt_idx" ON "ShopEvent"("createdAt");
CREATE INDEX "ShopEvent_type_idx" ON "ShopEvent"("type");
CREATE INDEX "ShopEvent_query_idx" ON "ShopEvent"("query");
CREATE INDEX "ShopEvent_city_idx" ON "ShopEvent"("city");
CREATE INDEX "ShopEvent_sku_idx" ON "ShopEvent"("sku");
