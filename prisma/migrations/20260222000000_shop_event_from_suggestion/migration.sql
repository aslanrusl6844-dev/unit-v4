-- Поисковое событие: выбрана ли подсказка. Только аддитивно и идемпотентно.
ALTER TABLE "ShopEvent" ADD COLUMN IF NOT EXISTS "fromSuggestion" BOOLEAN;
