-- Варианты количества и рич-контент «Детали» у товара. Только аддитивно и идемпотентно.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "quantityVariants" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "details" TEXT;
