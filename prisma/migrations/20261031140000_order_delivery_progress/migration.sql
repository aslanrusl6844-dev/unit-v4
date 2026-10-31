-- AlterTable
ALTER TABLE "ShopOrder" ADD COLUMN     "arrivedAt" TIMESTAMP(3),
ADD COLUMN     "hiddenByCustomer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shippedAt" TIMESTAMP(3);
