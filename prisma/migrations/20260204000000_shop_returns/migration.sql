-- CreateTable
CREATE TABLE "ShopReturn" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT,
    "reason" TEXT NOT NULL,
    "photos" TEXT,
    "packageOpened" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "ShopReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopReturn_status_idx" ON "ShopReturn"("status");
