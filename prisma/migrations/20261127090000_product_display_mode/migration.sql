-- Как показывать товар: card / hanger / shelf; фото для полочки
ALTER TABLE "Product" ADD COLUMN "displayMode" TEXT;
ALTER TABLE "Product" ADD COLUMN "shelfImage" TEXT;
