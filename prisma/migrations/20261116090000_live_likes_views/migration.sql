-- Лайки эфиров и просмотры повторов
ALTER TABLE "LiveStream" ADD COLUMN "likes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LiveStream" ADD COLUMN "views" INTEGER NOT NULL DEFAULT 0;
