-- AlterTable
ALTER TABLE "ShopCourierApplication" ADD COLUMN "iin" TEXT;

-- CreateTable
CREATE TABLE "ShopCourierInvite" (
    "phone" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "iin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopCourierInvite_pkey" PRIMARY KEY ("phone")
);
