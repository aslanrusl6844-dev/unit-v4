-- Закупка с галочкой «доплата к закупу Ozon» добавляется к закупу в «Отправлено на Ozon» (разница оптовых цен и т.п.).
ALTER TABLE "WholesalerPurchase" ADD COLUMN IF NOT EXISTS "shipExtra" BOOLEAN NOT NULL DEFAULT false;
