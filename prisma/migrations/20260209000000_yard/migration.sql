-- Таблицы двора уже создавал коммит 7г8. Повторный запуск не должен падать на «already exists».
CREATE TABLE IF NOT EXISTS "YardInvite" (
    "phone" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "iin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "YardInvite_pkey" PRIMARY KEY ("phone")
);

CREATE TABLE IF NOT EXISTS "YardApplication" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "iin" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "shopPhoto" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    CONSTRAINT "YardApplication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "YardShop" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "photo" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paidUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "YardShop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "YardItem" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "photo" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "YardItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "YardOrder" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "buyerPhone" TEXT NOT NULL,
    "buyerName" TEXT NOT NULL,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "total" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting_payment',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "YardOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "YardOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "qty" INTEGER NOT NULL,
    CONSTRAINT "YardOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "YardMessage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "YardMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "YardApplication_phone_key" ON "YardApplication"("phone");
CREATE UNIQUE INDEX IF NOT EXISTS "YardShop_phone_key" ON "YardShop"("phone");
CREATE INDEX IF NOT EXISTS "YardItem_shopId_idx" ON "YardItem"("shopId");
CREATE UNIQUE INDEX IF NOT EXISTS "YardOrder_publicId_key" ON "YardOrder"("publicId");
CREATE INDEX IF NOT EXISTS "YardOrder_shopId_idx" ON "YardOrder"("shopId");
CREATE INDEX IF NOT EXISTS "YardOrder_buyerPhone_idx" ON "YardOrder"("buyerPhone");
CREATE INDEX IF NOT EXISTS "YardOrderItem_orderId_idx" ON "YardOrderItem"("orderId");
CREATE INDEX IF NOT EXISTS "YardMessage_orderId_idx" ON "YardMessage"("orderId");

DO $$ BEGIN
  ALTER TABLE "YardItem" ADD CONSTRAINT "YardItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "YardShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "YardOrder" ADD CONSTRAINT "YardOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "YardShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "YardOrderItem" ADD CONSTRAINT "YardOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "YardOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "YardMessage" ADD CONSTRAINT "YardMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "YardOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
