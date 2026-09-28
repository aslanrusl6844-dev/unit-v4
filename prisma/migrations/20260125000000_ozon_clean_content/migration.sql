-- AlterTable
ALTER TABLE "Product" ADD COLUMN "characteristics" TEXT;

-- Уже залитый мусор: «Состав», похожий на свалку атрибутов Ozon (хештеги, ТН ВЭД,
-- код маркировки, код продавца, «Нет бренда»), очищаем. Заново он заполнится при
-- следующем синке Ozon — но уже по правилам (только отдельное поле «Состав»).
-- Пары LIKE + ILIKE: точный регистр из реальных данных срабатывает всегда, а
-- ILIKE дополнительно ловит остальные варианты регистра, если БД умеет
-- сворачивать кириллицу.
UPDATE "Product"
SET "composition" = NULL, "compositionSource" = NULL
WHERE "composition" IS NOT NULL AND (
     "composition" LIKE '%#Хештеги%' OR "composition" ILIKE '%#хештеги%'
  OR "composition" LIKE '%ТН ВЭД%'   OR "composition" ILIKE '%тн вэд%'
  OR "composition" LIKE '%Нужен код маркировки%' OR "composition" ILIKE '%нужен код маркировки%'
  OR "composition" LIKE '%Код продавца%' OR "composition" ILIKE '%код продавца%'
  OR "composition" LIKE '%Нет бренда%'   OR "composition" ILIKE '%нет бренда%'
);
