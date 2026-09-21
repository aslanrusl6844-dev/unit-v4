-- AlterEnum
ALTER TYPE "Marketplace" ADD VALUE 'APP';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "shopActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "shopPrice" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "shopOldPrice" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "shopStock" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN "category" TEXT;
ALTER TABLE "Product" ADD COLUMN "subcategory" TEXT;
ALTER TABLE "Product" ADD COLUMN "type" TEXT;
ALTER TABLE "Product" ADD COLUMN "description" TEXT;
ALTER TABLE "Product" ADD COLUMN "composition" TEXT;
ALTER TABLE "Product" ADD COLUMN "images" TEXT;
ALTER TABLE "Product" ADD COLUMN "shopDelivery" TEXT;
ALTER TABLE "Product" ADD COLUMN "banner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "bannerTitle" TEXT;
ALTER TABLE "Product" ADD COLUMN "bannerSubtitle" TEXT;

-- CreateTable
CREATE TABLE "ShopOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "pickupCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_payment',
    "city" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "house" TEXT NOT NULL,
    "apartment" TEXT,
    "entrance" TEXT,
    "floor" TEXT,
    "intercom" TEXT,
    "comment" TEXT,
    "customerName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "items" TEXT NOT NULL,
    "logisticsCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "ShopOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopOrder_number_key" ON "ShopOrder"("number");

-- CreateTable
CREATE TABLE "ShopReview" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "variant" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopReview_pkey" PRIMARY KEY ("id")
);
