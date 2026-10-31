-- AlterEnum
ALTER TYPE "Marketplace" ADD VALUE 'TEEZ';

-- CreateTable
CREATE TABLE "TeezStore" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeezStore_pkey" PRIMARY KEY ("id")
);
