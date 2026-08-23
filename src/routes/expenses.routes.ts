import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';

export const expensesRouter = Router();

const adSpendSchema = z.object({
  marketplace: z.enum(['KASPI', 'OZON', 'WB']),
  date: z.string(),
  amount: z.number().nonnegative(),
  note: z.string().optional(),
});

expensesRouter.get('/ad-spend', async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const where: any = {};
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) where.date.lte = new Date(to);
  }
  const items = await prisma.adSpend.findMany({ where, orderBy: { date: 'desc' } });
  res.json(items);
});

expensesRouter.post('/ad-spend', async (req, res) => {
  const parsed = adSpendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.adSpend.create({
    data: { ...parsed.data, date: new Date(parsed.data.date) },
  });
  res.status(201).json(item);
});

expensesRouter.delete('/ad-spend/:id', async (req, res) => {
  try {
    await prisma.adSpend.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Запись не найдена' });
  }
});

const manualExpenseSchema = z.object({
  marketplace: z.enum(['KASPI', 'OZON', 'WB']).optional().nullable(),
  category: z.string().min(1),
  date: z.string(),
  amount: z.number().nonnegative(),
  note: z.string().optional(),
});

expensesRouter.get('/manual', async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const where: any = {};
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) where.date.lte = new Date(to);
  }
  const items = await prisma.manualExpense.findMany({ where, orderBy: { date: 'desc' } });
  res.json(items);
});

expensesRouter.post('/manual', async (req, res) => {
  const parsed = manualExpenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.manualExpense.create({
    data: { ...parsed.data, date: new Date(parsed.data.date) },
  });
  res.status(201).json(item);
});

expensesRouter.delete('/manual/:id', async (req, res) => {
  try {
    await prisma.manualExpense.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Запись не найдена' });
  }
});
