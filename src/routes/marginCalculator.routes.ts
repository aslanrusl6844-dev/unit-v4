import { Router } from 'express';
import { z } from 'zod';
import { fetchProductPageInfo } from '../integrations/kaspi.scraper';
import { calcKaspiCommissionAmount, KASPI_TOP_CATEGORY_RATE } from '../integrations/kaspi.categories';
import { calculateKaspiDeliveryCost, KaspiDeliveryZone } from '../integrations/kaspi.delivery';

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
// Себестоимость теперь СОБИРАЕТСЯ из трёх частей (как у конкурента
// Northline) — это удобнее для тех, кто возит товар с 1688.com через карго:
//   costPrice = price1688 + cargoRatePerKg * weightKg + packagingCost
// Если кто-то уже знает готовую себестоимость одним числом — можно
// передать её напрямую в price1688, а cargoRatePerKg оставить 0.
const calcSchema = z.object({
  price: z.number().positive(),
  price1688: z.number().nonnegative().default(0),
  cargoRatePerKg: z.number().nonnegative().default(0),
  packagingCost: z.number().nonnegative().default(0),
  weightKg: z.number().positive().default(0.5),
  kaspiTopCategory: z.string(),
  kaspiLeafCategory: z.string().optional(),
  deliveryZone: z.enum(['city', 'kazakhstan', 'express']).default('kazakhstan'),
  kaspiDelivery: z.boolean().default(true),
  targetMarginPct: z.number().min(0).max(95).default(20),
});

marginCalculatorRouter.post('/calculate', (req, res) => {
  const parsed = calcSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const commissionRate = KASPI_TOP_CATEGORY_RATE[d.kaspiTopCategory] ?? null;
  const commission = calcKaspiCommissionAmount(d.price, {
    topCategory: d.kaspiTopCategory,
    leafCategory: d.kaspiLeafCategory,
  });
  const logistics = d.kaspiDelivery
    ? calculateKaspiDeliveryCost(d.price, d.weightKg, d.deliveryZone as KaspiDeliveryZone)
    : 0;

  const cargoCost = d.cargoRatePerKg * d.weightKg;
  const costPrice = d.price1688 + cargoCost + d.packagingCost;

  const netProfit = Math.round((d.price - commission - logistics - costPrice) * 100) / 100;
  const marginPct = d.price > 0 ? Math.round((netProfit / d.price) * 1000) / 10 : 0;
  const roiPct = costPrice > 0 ? Math.round((netProfit / costPrice) * 1000) / 10 : 0;
  const goalReached = marginPct >= d.targetMarginPct;

  res.json({
    price: d.price,
    commission,
    commissionRate,
    logistics,
    price1688: d.price1688,
    cargoCost: Math.round(cargoCost * 100) / 100,
    packagingCost: d.packagingCost,
    costPrice: Math.round(costPrice * 100) / 100,
    netProfit,
    marginPct,
    roiPct,
    targetMarginPct: d.targetMarginPct,
    goalReached,
    // Вердикт как у конкурента: "Брать" — не просто прибыльно, а достигает
    // ЦЕЛЕВОЙ маржи. Товар с маржой 3% формально "прибыльный", но брать его
    // в оборот обычно не имеет смысла.
    verdict: netProfit > 0 && goalReached ? 'BUY' : 'SKIP',
    isProfitable: netProfit > 0,
  });
});

/**
 * Для слайдера "что если уронить цену под демпинг" — тот же расчёт, но по
 * произвольной цене. Используется тот же эндпоинт /calculate с другим
 * значением price, чтобы формула точно не разъезжалась между "основным"
 * расчётом и "что если" — везде одна и та же функция на сервере.
 */
