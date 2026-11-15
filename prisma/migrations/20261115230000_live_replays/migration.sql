-- Повторы эфиров: облачная запись Agora в R2
ALTER TABLE "LiveStream" ADD COLUMN "recResourceId" TEXT;
ALTER TABLE "LiveStream" ADD COLUMN "recSid" TEXT;
ALTER TABLE "LiveStream" ADD COLUMN "recState" TEXT;
ALTER TABLE "LiveStream" ADD COLUMN "replayUrl" TEXT;
