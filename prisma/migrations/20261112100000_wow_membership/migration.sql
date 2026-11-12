-- Подписка «Вау»: скидка у товара, скидка в заказе, настройки и подписки покупателей.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "wowPercent" INTEGER;
ALTER TABLE "ShopOrder" ADD COLUMN IF NOT EXISTS "wowDiscount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ShopOrder" ADD COLUMN IF NOT EXISTS "membershipId" TEXT;
CREATE INDEX IF NOT EXISTS "ShopOrder_membershipId_idx" ON "ShopOrder"("membershipId");

CREATE TABLE IF NOT EXISTS "WowSettings" (
  "id" TEXT NOT NULL DEFAULT 'main',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "monthlyPrice" DOUBLE PRECISION NOT NULL DEFAULT 2990,
  "defaultPercent" INTEGER NOT NULL DEFAULT 5,
  "payInstructions" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WowSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WowMembership" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "customerName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending_payment',
  "price" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "WowMembership_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "WowMembership_phone_idx" ON "WowMembership"("phone");
CREATE INDEX IF NOT EXISTS "WowMembership_status_idx" ON "WowMembership"("status");
