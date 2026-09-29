-- AlterTable
ALTER TABLE "Product" ADD COLUMN "shopArticle" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopArticle_key" ON "Product"("shopArticle");
