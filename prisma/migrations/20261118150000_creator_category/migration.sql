-- AlterTable
ALTER TABLE "Creator" ADD COLUMN "category" TEXT,
ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;
