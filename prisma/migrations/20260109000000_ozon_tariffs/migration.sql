-- AlterTable
ALTER TABLE "Product" ADD COLUMN "ozonCommissionRatePct" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "ozonLogisticsAmount" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "ozonLastMileAmount" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "ozonReturnLogisticsAmount" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "ozonAcquiringAmount" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "ozonTariffsUpdatedAt" TIMESTAMP(3);
