-- Детали товара (массив URL фото/видео). Только аддитивно и идемпотентно.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "details" JSONB;
