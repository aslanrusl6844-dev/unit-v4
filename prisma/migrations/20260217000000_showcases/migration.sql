-- Подбаннерные витрины (бренды и магазины). Только новые таблицы: Product и все
-- существующие таблицы не меняются. Идемпотентно: повторный запуск безопасен.

CREATE TABLE IF NOT EXISTS "Showcase" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "bannerUrl" TEXT,
    "bannerTitle" TEXT,
    "bannerText" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Showcase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ShowcaseCollection" (
    "id" TEXT NOT NULL,
    "showcaseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShowcaseCollection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ShowcaseProduct" (
    "id" TEXT NOT NULL,
    "showcaseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShowcaseProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ShowcaseCollectionItem" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShowcaseCollectionItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Showcase_published_sortOrder_idx" ON "Showcase"("published", "sortOrder");
CREATE INDEX IF NOT EXISTS "ShowcaseCollection_showcaseId_sortOrder_idx" ON "ShowcaseCollection"("showcaseId", "sortOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "ShowcaseProduct_showcaseId_productId_key" ON "ShowcaseProduct"("showcaseId", "productId");
CREATE INDEX IF NOT EXISTS "ShowcaseProduct_productId_idx" ON "ShowcaseProduct"("productId");
CREATE UNIQUE INDEX IF NOT EXISTS "ShowcaseCollectionItem_collectionId_productId_key" ON "ShowcaseCollectionItem"("collectionId", "productId");
CREATE INDEX IF NOT EXISTS "ShowcaseCollectionItem_productId_idx" ON "ShowcaseCollectionItem"("productId");

-- Внешние ключи только между новыми таблицами (удаление витрины убирает её
-- подборки и привязки, но НЕ товары). Защитный блок: повтор не падает.
DO $$ BEGIN
  ALTER TABLE "ShowcaseCollection" ADD CONSTRAINT "ShowcaseCollection_showcaseId_fkey"
    FOREIGN KEY ("showcaseId") REFERENCES "Showcase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ShowcaseProduct" ADD CONSTRAINT "ShowcaseProduct_showcaseId_fkey"
    FOREIGN KEY ("showcaseId") REFERENCES "Showcase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ShowcaseCollectionItem" ADD CONSTRAINT "ShowcaseCollectionItem_collectionId_fkey"
    FOREIGN KEY ("collectionId") REFERENCES "ShowcaseCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
