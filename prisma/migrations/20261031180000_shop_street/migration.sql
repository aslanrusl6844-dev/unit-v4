-- CreateTable
CREATE TABLE "ShopStreet" (
    "id" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,

    CONSTRAINT "ShopStreet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopStreet_city_name_key" ON "ShopStreet"("city", "name");

-- CreateIndex
CREATE INDEX "ShopStreet_city_key_idx" ON "ShopStreet"("city", "key");
