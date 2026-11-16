-- Фискальные чеки re:Kassa по заказам My Market
CREATE TABLE "FiscalReceipt" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ticketId" INTEGER,
    "ticketNumber" TEXT,
    "qrUrl" TEXT,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FiscalReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FiscalReceipt_requestId_key" ON "FiscalReceipt"("requestId");
CREATE UNIQUE INDEX "FiscalReceipt_orderId_operation_key" ON "FiscalReceipt"("orderId", "operation");
CREATE INDEX "FiscalReceipt_orderId_idx" ON "FiscalReceipt"("orderId");
