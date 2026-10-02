-- AlterTable
ALTER TABLE "ShopOrder" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ShopOrder_archived_idx" ON "ShopOrder"("archived");
