-- Размеры одежды (S, M, L, XL…)
ALTER TABLE "Product" ADD COLUMN "sizes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
