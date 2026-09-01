-- CreateTable
CREATE TABLE "WbStore" (
    "id" TEXT NOT NULL,
    "apiToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WbStore_pkey" PRIMARY KEY ("id")
);
