-- Варианты количества у товара. Только аддитивно и идемпотентно.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "quantityVariants" TEXT;
