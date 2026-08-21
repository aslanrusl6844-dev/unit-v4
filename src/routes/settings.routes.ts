import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';

export const settingsRouter = Router();

/**
 * Один магазин на сервер (мульти-магазин можно добавить позже — сейчас
 * форма «Добавить магазин» на самом деле создаёт/обновляет единственную
 * запись). Токен здесь имеет приоритет над KASPI_API_TOKEN из .env —
 * см. src/integrations/kaspi.client.ts.
 */
settingsRouter.get('/kaspi-store', async (_req, res) => {
  const store = await prisma.kaspiStore.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!store) return res.json(null);
  // Токен целиком на фронт не отдаём — только последние 4 символа, чтобы
  // можно было убедиться, что он сохранён, не показывая его полностью.
  res.json({ ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` });
});

const kaspiStoreSchema = z.object({
  name: z.string().min(1, 'Укажите название магазина'),
  bin: z.string().optional().nullable(),
  contactPhone: z.string().optional().nullable(),
  contactEmail: z.string().optional().nullable(),
  apiToken: z.string().min(10, 'Токен обязателен и должен быть похож на настоящий'),
  merchantUid: z.string().optional().nullable(),
});

settingsRouter.post('/kaspi-store', async (req, res) => {
  const parsed = kaspiStoreSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const existing = await prisma.kaspiStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    const store = existing
      ? await prisma.kaspiStore.update({ where: { id: existing.id }, data: parsed.data })
      : await prisma.kaspiStore.create({ data: parsed.data });

    res.status(201).json({ ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` });
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось сохранить магазин', details: String(err?.message ?? err) });
  }
});

settingsRouter.delete('/kaspi-store/:id', async (req, res) => {
  try {
    await prisma.kaspiStore.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Магазин не найден' });
  }
});
