-- Ozon: дата начисления продажи и сумма к выплате по заказу.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "payoutAmount" DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS "Order_marketplace_settledAt_idx" ON "Order"("marketplace", "settledAt");
