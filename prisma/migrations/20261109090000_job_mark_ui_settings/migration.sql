-- Отметки фоновых задач (цены Ozon раз в 5 минут).
CREATE TABLE IF NOT EXISTS "JobMark" (
    "id" TEXT NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobMark_pkey" PRIMARY KEY ("id")
);

-- Настройки вида баннеров (таблица уже создана вручную — тут на случай новой базы).
CREATE TABLE IF NOT EXISTS "ShopUiSettings" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "bannerTransition" TEXT NOT NULL DEFAULT 'slide',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShopUiSettings_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ShopUiSettings" ADD COLUMN IF NOT EXISTS "showcaseTransition" TEXT NOT NULL DEFAULT 'slide';
ALTER TABLE "ShopUiSettings" ADD COLUMN IF NOT EXISTS "captionEffect" TEXT NOT NULL DEFAULT 'rise';
