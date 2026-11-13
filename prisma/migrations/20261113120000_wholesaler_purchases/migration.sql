-- Закупки у оптовиков (учёт потраченных денег).
CREATE TABLE IF NOT EXISTS "WholesalerPurchase" (
  "id" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "wholesalerId" TEXT,
  "note" TEXT,
  "date" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WholesalerPurchase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "WholesalerPurchase_date_idx" ON "WholesalerPurchase"("date");
CREATE INDEX IF NOT EXISTS "WholesalerPurchase_wholesalerId_idx" ON "WholesalerPurchase"("wholesalerId");
