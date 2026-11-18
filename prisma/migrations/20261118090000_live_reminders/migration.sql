-- CreateTable
CREATE TABLE "LiveReminder" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "phone" TEXT,
    "pushToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveReminder_streamId_deviceKey_key" ON "LiveReminder"("streamId", "deviceKey");

-- CreateIndex
CREATE INDEX "LiveReminder_streamId_idx" ON "LiveReminder"("streamId");
