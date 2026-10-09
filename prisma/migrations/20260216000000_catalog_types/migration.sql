-- Справочник типов каталога My Market. Идемпотентно: повторный запуск ничего не ломает.
CREATE TABLE IF NOT EXISTS "CatalogType" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CatalogType_category_type_key" ON "CatalogType"("category", "type");
CREATE INDEX IF NOT EXISTS "CatalogType_category_sortOrder_idx" ON "CatalogType"("category", "sortOrder");
