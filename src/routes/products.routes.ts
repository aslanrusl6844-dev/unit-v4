import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { KASPI_TOP_CATEGORY_RATE } from '../integrations/kaspi.categories';

export const productsRouter = Router();

productsRouter.get('/', async (_req, res) => {
  const startedAt = Date.now();
  try {
    const products = await prisma.product.findMany({ orderBy: { updatedAt: 'desc' } });
    logger.info(`[DB] GET /products — ${Date.now() - startedAt}мс, найдено: ${products.length}`);
    res.json(products);
  } catch (err) {
    logger.error({ err }, `[DB] GET /products упал через ${Date.now() - startedAt}мс`);
    res.status(500).json({ error: 'Ошибка получения товаров', details: String((err as any)?.message ?? err) });
  }
});

// Список категорий 1-го уровня Kaspi со ставками — для выпадающего списка в форме товара.
productsRouter.get('/kaspi-categories', (_req, res) => {
  const categories = Object.entries(KASPI_TOP_CATEGORY_RATE).map(([name, rate]) => ({ name, rate }));
  res.json(categories);
});

const productSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  costPrice: z.number().nonnegative(),
  packagingCost: z.number().nonnegative().default(0),
  weightKg: z.number().positive().default(0.5),
  kaspiSku: z.string().optional().nullable(),
  kaspiTopCategory: z.string().optional().nullable(),
  kaspiLeafCategory: z.string().optional().nullable(),
  ozonOfferId: z.string().optional().nullable(),
  ozonSku: z.number().optional().nullable(),
  wbArticle: z.string().optional().nullable(),
  wbNmId: z.number().optional().nullable(),
  active: z.boolean().optional().default(true),
});

productsRouter.post('/', async (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const startedAt = Date.now();
  try {
    const product = await prisma.product.create({ data: parsed.data });
    logger.info(`[DB] POST /products — ${Date.now() - startedAt}мс, создан: ${product.id}`);
    res.status(201).json(product);
  } catch (err: any) {
    logger.error({ err }, `[DB] POST /products упал через ${Date.now() - startedAt}мс`);
    // P2002 = нарушение уникальности (например, такой SKU/kaspiSku уже есть) — частая, понятная причина.
    if (err?.code === 'P2002') {
      return res.status(409).json({
        error: 'Товар с таким SKU, артикулом Kaspi, Ozon или WB уже существует',
        details: String(err?.meta?.target ?? ''),
      });
    }
    res.status(500).json({ error: 'Ошибка создания товара', details: String(err?.message ?? err) });
  }
});

/**
 * Массовая загрузка товаров (Excel/CSV) — файл парсится в браузере
 * (см. public/dashboard.js), сюда приходит уже готовый JSON-массив.
 * Сервер сам режет присланное на партии по 200 строк на транзакцию —
 * так безопаснее для serverless-таймаутов, даже если с фронта вдруг
 * прилетит большой массив целиком.
 */
const bulkRowSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  kaspiSku: z.string().optional().nullable(),
  costPrice: z.number().nonnegative().default(0),
  kaspiTopCategory: z.string().optional().nullable(),
});

const BULK_CHUNK_SIZE = 200;

productsRouter.post('/bulk-upsert', async (req, res) => {
  const bodySchema = z.object({ products: z.array(bulkRowSchema).min(1).max(2000) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Неверный формат данных', details: parsed.error.flatten() });
  }

  const rows = parsed.data.products;
  let created = 0;
  let updated = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_CHUNK_SIZE);
    try {
      const results = await prisma.$transaction(
        chunk.map((row) =>
          prisma.product.upsert({
            where: { sku: row.sku },
            update: {
              name: row.name,
              costPrice: row.costPrice,
              ...(row.kaspiSku ? { kaspiSku: row.kaspiSku } : {}),
              ...(row.kaspiTopCategory ? { kaspiTopCategory: row.kaspiTopCategory } : {}),
            },
            create: {
              sku: row.sku,
              name: row.name,
              costPrice: row.costPrice,
              kaspiSku: row.kaspiSku || null,
              kaspiTopCategory: row.kaspiTopCategory || null,
            },
          }),
        ),
      );
      // upsert не говорит напрямую "создан или обновлён" — считаем по createdAt≈updatedAt.
      results.forEach((r) => {
        if (Math.abs(r.createdAt.getTime() - r.updatedAt.getTime()) < 1000) created += 1;
        else updated += 1;
      });
    } catch (err: any) {
      logger.error({ err }, `[Bulk] Ошибка в партии строк ${i}-${i + chunk.length}`);
      // Транзакция всей партии упала (например, дубликат kaspiSku внутри
      // самой партии) — пробуем построчно, чтобы не терять весь пакет из-за одной плохой строки.
      for (const row of chunk) {
        try {
          const existing = await prisma.product.findUnique({ where: { sku: row.sku } });
          if (existing) {
            await prisma.product.update({
              where: { sku: row.sku },
              data: {
                name: row.name,
                costPrice: row.costPrice,
                ...(row.kaspiSku ? { kaspiSku: row.kaspiSku } : {}),
                ...(row.kaspiTopCategory ? { kaspiTopCategory: row.kaspiTopCategory } : {}),
              },
            });
            updated += 1;
          } else {
            await prisma.product.create({
              data: {
                sku: row.sku,
                name: row.name,
                costPrice: row.costPrice,
                kaspiSku: row.kaspiSku || null,
                kaspiTopCategory: row.kaspiTopCategory || null,
              },
            });
            created += 1;
          }
        } catch (rowErr: any) {
          errors.push(`${row.sku}: ${String(rowErr?.message ?? rowErr).slice(0, 150)}`);
        }
      }
    }
  }

  logger.info(`[Bulk] Загрузка завершена: создано ${created}, обновлено ${updated}, ошибок ${errors.length}`);
  res.json({ ok: true, total: rows.length, created, updated, errors: errors.slice(0, 50) });
});

productsRouter.put('/:id', async (req, res) => {
  const parsed = productSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const product = await prisma.product.update({ where: { id: req.params.id }, data: parsed.data });
    res.json(product);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Товар не найден' });
    logger.error({ err }, `[DB] PUT /products/${req.params.id} упал`);
    res.status(500).json({ error: 'Не удалось обновить товар', details: String(err?.message ?? err) });
  }
});

productsRouter.delete('/:id', async (req, res) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Товар не найден' });
    logger.error({ err }, `[DB] DELETE /products/${req.params.id} упал`);
    res.status(500).json({ error: 'Не удалось удалить товар', details: String(err?.message ?? err) });
  }
});
