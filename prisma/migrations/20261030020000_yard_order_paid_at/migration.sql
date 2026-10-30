-- Время подтверждения оплаты заказа двора.
ALTER TABLE "YardOrder" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
-- Уже оплаченные ранее заказы: точное время неизвестно — берём время создания, чтобы они не выглядели «свежими».
UPDATE "YardOrder" SET "paidAt" = "createdAt" WHERE "paidAt" IS NULL AND "status" IN ('paid', 'accepted', 'at_door', 'done', 'not_picked', 'out_of_stock');
