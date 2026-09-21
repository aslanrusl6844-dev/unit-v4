-- CreateTable
CREATE TABLE "ShopBanner" (
    "id" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "title" TEXT,
    "subtitle" TEXT,
    "linkType" TEXT,
    "linkValue" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopBanner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopBanner_slot_key" ON "ShopBanner"("slot");
