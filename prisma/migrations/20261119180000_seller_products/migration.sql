-- AlterTable
ALTER TABLE "Creator" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'creator',
ADD COLUMN "companyName" TEXT,
ADD COLUMN "bin" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "sellerId" TEXT;

-- CreateIndex
CREATE INDEX "Product_sellerId_idx" ON "Product"("sellerId");
