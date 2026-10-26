-- Слайды городов: до 10 картинок на город (раньше — одна в "CityImage").
CREATE TABLE IF NOT EXISTS "CityImageSlide" (
    "id" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CityImageSlide_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CityImageSlide_city_position_idx" ON "CityImageSlide"("city", "position");

-- Уже загруженные одиночные картинки становятся первым слайдом города.
INSERT INTO "CityImageSlide" ("id", "city", "imageUrl", "position", "createdAt")
SELECT 'legacy-' || ci."city", ci."city", ci."imageUrl", 0, CURRENT_TIMESTAMP
FROM "CityImage" ci
WHERE NOT EXISTS (SELECT 1 FROM "CityImageSlide" s WHERE s."id" = 'legacy-' || ci."city");
