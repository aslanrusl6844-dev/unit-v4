-- CreateTable
CREATE TABLE "ShopCourierApplication" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "ShopCourierApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopCourierApplication_phone_key" ON "ShopCourierApplication"("phone");

-- DataMigration: уже зарегистрированные активные курьеры не должны быть
-- заблокированы новым правилом — переносим их как уже одобренные. Город
-- неизвестен (поля не было) — ставим заглушку "—", админ сможет поправить
-- вручную при необходимости, повторная регистрация это не ломает.
INSERT INTO "ShopCourierApplication" ("id", "phone", "name", "city", "status", "createdAt", "reviewedAt")
SELECT
  'migr_' || c.id,
  c.phone,
  c.name,
  '—',
  'approved',
  c."createdAt",
  c."createdAt"
FROM "Courier" c
WHERE c.active = true
ON CONFLICT ("phone") DO NOTHING;
