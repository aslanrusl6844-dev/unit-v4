-- AlterTable
ALTER TABLE "ShopReview" ADD COLUMN "orderId" TEXT;
ALTER TABLE "ShopReview" ADD COLUMN "authorPhone" TEXT;
ALTER TABLE "ShopReview" ADD COLUMN "textPros" TEXT;
ALTER TABLE "ShopReview" ADD COLUMN "textCons" TEXT;
ALTER TABLE "ShopReview" ADD COLUMN "tags" TEXT;

-- CreateIndex
CREATE INDEX "ShopReview_sku_idx" ON "ShopReview"("sku");
