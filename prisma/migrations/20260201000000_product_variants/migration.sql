-- AlterTable
ALTER TABLE "Product" ADD COLUMN "variantGroup" TEXT;
ALTER TABLE "Product" ADD COLUMN "variantLabel" TEXT;

-- CreateIndex
CREATE INDEX "Product_variantGroup_idx" ON "Product"("variantGroup");
