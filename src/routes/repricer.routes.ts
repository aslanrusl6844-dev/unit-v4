import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { runRepricingCycle } from '../services/repricer.service';

export const repricerRouter = Router();

const settingsSchema = z.object({
  kaspiProductUrl: z.string().url().optional().nullable(),
  autoRepriceEnabled: z.boolean().optional(),
  minPrice: z.number().positive().optional().nullable(),
  maxPrice: z.number().positive().optional().nullable(),
  repriceStep: z.number().nonnegative().optional(),
  repriceStrategy: z.enum(['FIRST_PLACE', 'MATCH_FIRST', 'STICK_TO_FIRST', 'SECOND_PLACE']).optional(),
});

// Настроить автобот для конкретного товара.
repricerRouter.put('/:productId/settings', async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const product = await prisma.product.update({
      where: { id: req.params.productId },
      data: parsed.data,
    });
    res.json(product);
  } catch {
    res.status(404).json({ error: 'Товар не найден' });
  }
});

// История изменений цены по товару.
repricerRouter.get('/:productId/history', async (req, res) => {
  const history = await prisma.priceHistory.findMany({
    where: { productId: req.params.productId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(history);
});

// Запустить пересчёт цен вручную (не дожидаясь расписания).
repricerRouter.post('/run', async (_req, res) => {
  try {
    const results = await runRepricingCycle();
    res.json({ ok: true, results });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});
