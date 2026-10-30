-- Размер шрифта бегущей строки витрины (необязательный; пусто — 20).
ALTER TABLE "Showcase" ADD COLUMN IF NOT EXISTS "tickerSize" INTEGER;
