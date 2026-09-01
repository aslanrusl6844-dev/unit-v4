-- AlterTable
ALTER TABLE "Product" ADD COLUMN "kaspiReferencePrice" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "kaspiReferencePriceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN "ozonReferencePrice" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "ozonReferencePriceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN "wbReferencePrice" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "wbReferencePriceUpdatedAt" TIMESTAMP(3);

-- Переносим уже накопленные значения старого единого referencePrice в
-- поле подходящей площадки — по тому, к какой площадке товар относится
-- (если относится к нескольким — используем первую по приоритету
-- Kaspi > Ozon > WB, дальше синхронизация сама уточнит значения по
-- каждой площадке отдельно).
UPDATE "Product" SET "kaspiReferencePrice" = "referencePrice", "kaspiReferencePriceUpdatedAt" = "referencePriceUpdatedAt"
  WHERE "referencePrice" IS NOT NULL AND "kaspiSku" IS NOT NULL;
UPDATE "Product" SET "ozonReferencePrice" = "referencePrice", "ozonReferencePriceUpdatedAt" = "referencePriceUpdatedAt"
  WHERE "referencePrice" IS NOT NULL AND "kaspiSku" IS NULL AND "ozonOfferId" IS NOT NULL;
UPDATE "Product" SET "wbReferencePrice" = "referencePrice", "wbReferencePriceUpdatedAt" = "referencePriceUpdatedAt"
  WHERE "referencePrice" IS NOT NULL AND "kaspiSku" IS NULL AND "ozonOfferId" IS NULL AND "wbArticle" IS NOT NULL;
