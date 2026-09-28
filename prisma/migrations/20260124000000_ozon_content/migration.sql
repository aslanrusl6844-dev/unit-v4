-- AlterTable
ALTER TABLE "Product" ADD COLUMN "ozonType" TEXT;
ALTER TABLE "Product" ADD COLUMN "descriptionSource" TEXT;
ALTER TABLE "Product" ADD COLUMN "compositionSource" TEXT;
ALTER TABLE "Product" ADD COLUMN "categorySource" TEXT;

-- CreateTable
CREATE TABLE "OzonTypeMap" (
    "id" TEXT NOT NULL,
    "ozonTypeKey" TEXT NOT NULL,
    "ozonTypeLabel" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OzonTypeMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OzonTypeMap_ozonTypeKey_key" ON "OzonTypeMap"("ozonTypeKey");
