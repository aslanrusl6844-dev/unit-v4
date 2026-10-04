-- CreateTable
CREATE TABLE IF NOT EXISTS "YardShopMessage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "buyerPhone" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YardShopMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "YardShopMessage_shopId_buyerPhone_idx" ON "YardShopMessage"("shopId", "buyerPhone");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "YardShopMessage" ADD CONSTRAINT "YardShopMessage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "YardShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
