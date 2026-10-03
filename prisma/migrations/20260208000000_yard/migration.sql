-- CreateTable
CREATE TABLE "YardShop" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paidUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YardShop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YardItem" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "photo" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "YardItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YardOrder" (
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

-- CreateTable
CREATE TABLE "YardOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "YardOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YardMessage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YardMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YardShop_phone_key" ON "YardShop"("phone");

-- CreateIndex
CREATE INDEX "YardItem_shopId_idx" ON "YardItem"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "YardOrder_publicId_key" ON "YardOrder"("publicId");

-- CreateIndex
CREATE INDEX "YardOrder_shopId_idx" ON "YardOrder"("shopId");

-- CreateIndex
CREATE INDEX "YardOrder_buyerPhone_idx" ON "YardOrder"("buyerPhone");

-- CreateIndex
CREATE INDEX "YardOrderItem_orderId_idx" ON "YardOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "YardMessage_orderId_idx" ON "YardMessage"("orderId");

-- AddForeignKey
ALTER TABLE "YardItem" ADD CONSTRAINT "YardItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "YardShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YardOrder" ADD CONSTRAINT "YardOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "YardShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YardOrderItem" ADD CONSTRAINT "YardOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "YardOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YardMessage" ADD CONSTRAINT "YardMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "YardOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
