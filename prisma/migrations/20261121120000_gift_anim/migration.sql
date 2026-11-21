-- Анимация подарка на весь экран (анимированный WEBP с прозрачностью), как лев в ТикТоке.
ALTER TABLE "LiveGift" ADD COLUMN IF NOT EXISTS "animUrl" TEXT;
