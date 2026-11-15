-- Креаторы My Market Live: заявки и одобренные креаторы
CREATE TABLE "CreatorApplication" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "answers" TEXT NOT NULL,
    "trialVideoUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    CONSTRAINT "CreatorApplication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorApplication_phone_key" ON "CreatorApplication"("phone");
CREATE INDEX "CreatorApplication_status_idx" ON "CreatorApplication"("status");

CREATE TABLE "Creator" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "percent" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "applicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Creator_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Creator_phone_key" ON "Creator"("phone");
CREATE UNIQUE INDEX "Creator_code_key" ON "Creator"("code");
