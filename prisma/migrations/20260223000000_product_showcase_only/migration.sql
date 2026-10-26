-- Товар только для витрин (не попадает в общий каталог). Только аддитивно и идемпотентно.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "showcaseOnly" BOOLEAN NOT NULL DEFAULT false;
