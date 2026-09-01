-- CreateTable
CREATE TABLE "TaxSettings" (
    "id" TEXT NOT NULL,
    "ratePct" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxSettings_pkey" PRIMARY KEY ("id")
);
