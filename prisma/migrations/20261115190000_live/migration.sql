-- My Market Live: шортс креаторов, лайки, прямые эфиры, чат эфира
ALTER TABLE "Creator" ADD COLUMN "autoPublish" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "CreatorVideo" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL,
    "skus" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "likes" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorVideo_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CreatorVideo_status_createdAt_idx" ON "CreatorVideo"("status", "createdAt");
CREATE INDEX "CreatorVideo_creatorId_idx" ON "CreatorVideo"("creatorId");

CREATE TABLE "CreatorVideoLike" (
    "id" SERIAL NOT NULL,
    "videoId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorVideoLike_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorVideoLike_videoId_deviceKey_key" ON "CreatorVideoLike"("videoId", "deviceKey");

CREATE TABLE "LiveStream" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "skus" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastBeatAt" TIMESTAMP(3),
    "peakViewers" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveStream_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LiveStream_channel_key" ON "LiveStream"("channel");
CREATE INDEX "LiveStream_status_idx" ON "LiveStream"("status");
CREATE INDEX "LiveStream_creatorId_idx" ON "LiveStream"("creatorId");

CREATE TABLE "LiveChatMessage" (
    "id" SERIAL NOT NULL,
    "streamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "fromHost" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveChatMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LiveChatMessage_streamId_id_idx" ON "LiveChatMessage"("streamId", "id");
