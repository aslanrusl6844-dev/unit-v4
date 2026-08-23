-- CreateEnum
CREATE TYPE "RepriceStrategy" AS ENUM ('FIRST_PLACE', 'MATCH_FIRST', 'STICK_TO_FIRST', 'SECOND_PLACE');

-- CreateTable
CREATE TABLE "KaspiStore" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bin" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "apiToken" TEXT NOT NULL,
    "merchantUid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KaspiStore_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "maxPrice" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "repriceStrategy" "RepriceStrategy" NOT NULL DEFAULT 'FIRST_PLACE';
