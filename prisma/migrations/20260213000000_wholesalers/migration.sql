-- CreateTable
CREATE TABLE IF NOT EXISTS "Wholesaler" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wholesaler_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WholesalerProduct" (
    "productId" TEXT NOT NULL,
    "wholesalerId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WholesalerProduct_pkey" PRIMARY KEY ("productId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WholesalerProduct_wholesalerId_idx" ON "WholesalerProduct"("wholesalerId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "WholesalerProduct" ADD CONSTRAINT "WholesalerProduct_wholesalerId_fkey" FOREIGN KEY ("wholesalerId") REFERENCES "Wholesaler"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
