import { Router } from 'express';
import { z } from 'zod';
import { fetchProductPageInfo } from '@/integrations/kaspi.scraper';
import { calcKaspiCommissionAmount, KASPI_TOP_CATEGORY_RATE } from '@/integrations/kaspi.categories';
import { calculateKaspiDeliveryCost, KaspiDeliveryZone } from '@/integrations/kaspi.delivery';

export const marginCalculatorRouter = Router();

// Шаг 1: вставили ссылку — подтягиваем название и текущую цену со страницы.
marginCalculatorRouter.post('/scrape', async (req, res) => {
  const schema = z.object({ url: z.string().url() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const info = await fetchProductPageInfo(parsed.data.url);
  if (!info.price) {
    return res.status(422).json({ error: 'Не удалось прочитать цену со страницы. Заполните поля вручную.' });
  }
  res.json(info);
});

// Список категорий для выпадающего списка на этом же экране.
marginCalculatorRouter.get('/categories', (_req, res) => {
  res.json(Object.entries(KASPI_TOP_CATEGORY_RATE).map(([name, rate]) => ({ name, rate })));
});

// Шаг 2: считаем маржу по введённым данным.
const calcSchema = z.object({
  price: z.number().positive(),
  costPrice: z.number().nonnegative(),
  packagingCost: z.number().nonnegative().default(0),
  weightKg: z.number().positive().default(0.5),
  kaspiTopCategory: z.string(),
  kaspiLeafCategory: z.string().optional(),
  deliveryZone: z.enum(['city', 'kazakhstan', 'express']).default('kazakhstan'),
  kaspiDelivery: z.boolean().default(true),
});

marginCalculatorRouter.post('/calculate', (req, res) => {
  const parsed = calcSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const commission = calcKaspiCommissionAmount(d.price, {
    topCategory: d.kaspiTopCategory,
    leafCategory: d.kaspiLeafCategory,
  });
  const logistics = d.kaspiDelivery
    ? calculateKaspiDeliveryCost(d.price, d.weightKg, d.deliveryZone as KaspiDeliveryZone)
    : 0;

  const totalCost = d.costPrice + d.packagingCost;
  const netProfit = Math.round((d.price - commission - logistics - totalCost) * 100) / 100;
  const marginPct = d.price > 0 ? Math.round((netProfit / d.price) * 1000) / 10 : 0;
  const roiPct = totalCost > 0 ? Math.round((netProfit / totalCost) * 1000) / 10 : 0;

  res.json({
    price: d.price,
    commission,
    logistics,
    costPrice: d.costPrice,
    packagingCost: d.packagingCost,
    netProfit,
    marginPct,
    roiPct,
    isProfitable: netProfit > 0,
  });
});
