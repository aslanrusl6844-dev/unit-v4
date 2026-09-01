-- CreateTable
CREATE TABLE "OzonStore" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OzonStore_pkey" PRIMARY KEY ("id")
);
