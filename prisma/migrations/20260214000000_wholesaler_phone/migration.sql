-- AlterTable: телефон оптовика (необязательный). Старая миграция оптовиков не менялась.
ALTER TABLE "Wholesaler" ADD COLUMN IF NOT EXISTS "phone" TEXT;
