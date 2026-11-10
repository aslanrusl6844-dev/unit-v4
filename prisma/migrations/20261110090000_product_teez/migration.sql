-- Tez Market: каталог Teez у товара.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "teezSku" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "teezProductId" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "teezReferencePrice" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "teezReferencePriceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "teezCommissionRatePct" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "teezStock" INTEGER;
CREATE INDEX IF NOT EXISTS "Product_teezSku_idx" ON "Product"("teezSku");
