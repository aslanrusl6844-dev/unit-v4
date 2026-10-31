-- CreateTable
CREATE TABLE "YandexCloudStore" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YandexCloudStore_pkey" PRIMARY KEY ("id")
);
