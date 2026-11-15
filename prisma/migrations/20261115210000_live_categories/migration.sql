-- Вкладки-категории My Market Live
CREATE TABLE "LiveCategory" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "categories" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LiveCategory_pkey" PRIMARY KEY ("id")
);
