-- CreateTable
CREATE TABLE "ShopCustomerPushToken" (
    "phone" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopCustomerPushToken_pkey" PRIMARY KEY ("phone")
);
