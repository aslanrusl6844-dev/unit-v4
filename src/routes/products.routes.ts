import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@/db/prisma';
import { KASPI_TOP_CATEGORY_RATE } from '@/integrations/kaspi.categories';

export const productsRouter = Router();

productsRouter.get('/', async (_req, res) => {
  const products = await prisma.product.findMany({ orderBy: { updatedAt: 'desc' } });
  res.json(products);
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
  const product = await prisma.product.create({ data: parsed.data });
  res.status(201).json(product);
});

productsRouter.put('/:id', async (req, res) => {
  const parsed = productSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const product = await prisma.product.update({ where: { id: req.params.id }, data: parsed.data });
    res.json(product);
  } catch {
    res.status(404).json({ error: 'Товар не найден' });
  }
});

productsRouter.delete('/:id', async (req, res) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Товар не найден' });
  }
});
