-- AlterTable
ALTER TABLE "ShopCourierApplication" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ShopCourierApplication_archived_idx" ON "ShopCourierApplication"("archived");

-- Уже отклонённые заявки (из версии до архива) переносим в архив сразу —
-- иначе они повисли бы в «Заявках» до первого ручного переноса, хотя по
-- новому правилу отказ архивирует автоматически.
UPDATE "ShopCourierApplication" SET "archived" = true WHERE "status" = 'rejected';
