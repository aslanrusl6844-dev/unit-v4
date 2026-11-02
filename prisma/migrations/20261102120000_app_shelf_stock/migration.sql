-- AlterTable
ALTER TABLE "Wholesaler" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WholesalerProduct" ADD COLUMN "savedStock" INTEGER;
