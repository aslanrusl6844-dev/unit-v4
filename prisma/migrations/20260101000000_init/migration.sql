-- CreateEnum
CREATE TYPE "Marketplace" AS ENUM ('KASPI', 'OZON', 'WB');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "costPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "packagingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weightKg" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "kaspiSku" TEXT,
    "kaspiTopCategory" TEXT,
    "kaspiLeafCategory" TEXT,
    "ozonOfferId" TEXT,
    "ozonSku" INTEGER,
    "wbArticle" TEXT,
    "wbNmId" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "kaspiProductUrl" TEXT,
    "autoRepriceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minPrice" DOUBLE PRECISION,
    "repriceStep" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "currentKaspiPrice" DOUBLE PRECISION,
    "lastRepricedAt" TIMESTAMP(3),
    "kaspiRating" DOUBLE PRECISION,
    "kaspiReviewCount" INTEGER,
    "reviewsUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "oldPrice" DOUBLE PRECISION,
    "newPrice" DOUBLE PRECISION NOT NULL,
    "lowestCompetitorPrice" DOUBLE PRECISION,
    "hitFloor" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "deliveryType" TEXT,
    "city" TEXT,
    "kaspiInternalId" TEXT,
    "numberOfSpace" INTEGER,
    "waybillGeneratedAt" TIMESTAMP(3),
    "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marketplaceCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "logisticsCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "acquiringCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "adSpendAllocated" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rawData" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "externalSku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price" DOUBLE PRECISION NOT NULL,
    "costPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSpend" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdSpend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualExpense" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace",
    "category" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "ordersProcessed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_kaspiSku_key" ON "Product"("kaspiSku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_ozonOfferId_key" ON "Product"("ozonOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_wbArticle_key" ON "Product"("wbArticle");

-- CreateIndex
CREATE INDEX "Product_kaspiSku_idx" ON "Product"("kaspiSku");

-- CreateIndex
CREATE INDEX "Product_ozonOfferId_idx" ON "Product"("ozonOfferId");

-- CreateIndex
CREATE INDEX "PriceHistory_productId_idx" ON "PriceHistory"("productId");

-- CreateIndex
CREATE INDEX "Order_marketplace_orderDate_idx" ON "Order"("marketplace", "orderDate");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_marketplace_externalId_key" ON "Order"("marketplace", "externalId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE INDEX "OrderItem_externalSku_idx" ON "OrderItem"("externalSku");

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
