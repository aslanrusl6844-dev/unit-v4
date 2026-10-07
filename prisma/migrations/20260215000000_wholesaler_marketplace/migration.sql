-- Оптовики по площадкам. Старые миграции оптовиков не менялись; все шаги повторяемы.

-- Площадка оптовика. Уже существующие оптовики (Аслан, Мариям) становятся оптовиками Kaspi.
ALTER TABLE "Wholesaler" ADD COLUMN IF NOT EXISTS "marketplace" TEXT NOT NULL DEFAULT 'KASPI';

-- Площадка привязки товара: берётся у оптовика.
ALTER TABLE "WholesalerProduct" ADD COLUMN IF NOT EXISTS "marketplace" TEXT;
UPDATE "WholesalerProduct" wp SET "marketplace" = w."marketplace"
  FROM "Wholesaler" w WHERE w."id" = wp."wholesalerId" AND wp."marketplace" IS NULL;
ALTER TABLE "WholesalerProduct" ALTER COLUMN "marketplace" SET NOT NULL;

-- Первичный ключ: (товар, площадка) вместо одного товара — товар может быть на полке Kaspi и на полке Ozon.
DO $$ BEGIN
  IF (SELECT count(*) FROM information_schema.key_column_usage
        WHERE table_name = 'WholesalerProduct' AND constraint_name = 'WholesalerProduct_pkey') = 1 THEN
    ALTER TABLE "WholesalerProduct" DROP CONSTRAINT "WholesalerProduct_pkey";
    ALTER TABLE "WholesalerProduct" ADD CONSTRAINT "WholesalerProduct_pkey" PRIMARY KEY ("productId", "marketplace");
  END IF;
END $$;
