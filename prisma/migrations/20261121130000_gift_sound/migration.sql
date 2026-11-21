-- Звук подарка (рёв, крик): играет вместе с анимацией на весь экран.
ALTER TABLE "LiveGift" ADD COLUMN IF NOT EXISTS "soundUrl" TEXT;
