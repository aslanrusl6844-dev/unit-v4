import { Router } from 'express';
import { ozonClient } from '../integrations/ozon.client';
import { almatyStartOfDay, almatyEndOfDay } from '../utils/timezone';

export const ozonFboRouter = Router();

const msg = (err: any) => String(err?.message ?? err);

/**
 * GET /api/ozon-fbo?from=&to= — раздел FBO: остатки на складах Ozon, продажи
 * FBO за период (по товарам) и возвраты FBO с причинами. Каждый блок
 * загружается отдельно: ошибка одного не ломает остальные.
 */
ozonFboRouter.get('/', async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const dateTo = to ? almatyEndOfDay(to) : new Date();
  const dateFrom = from ? almatyStartOfDay(from) : new Date(dateTo.getTime() - 30 * 24 * 3600 * 1000);

  const [stocksR, postingsR, returnsR] = await Promise.allSettled([
    ozonClient.fetchFboStocks(),
    ozonClient.fetchFboPostings(dateFrom, dateTo),
    ozonClient.fetchReturns(dateFrom, dateTo),
  ]);

  const stocks = stocksR.status === 'fulfilled' ? stocksR.value : [];
  const soldMap = new Map<string, { offerId: string; name: string; sold: number; cancelled: number; revenue: number }>();
  if (postingsR.status === 'fulfilled') {
    for (const p of postingsR.value) {
      const key = p.offerId || p.name;
      const e = soldMap.get(key) ?? { offerId: p.offerId, name: p.name, sold: 0, cancelled: 0, revenue: 0 };
      if (/cancel/i.test(p.status)) e.cancelled += p.quantity;
      else { e.sold += p.quantity; e.revenue += p.price * p.quantity; }
      soldMap.set(key, e);
    }
  }
  const fboReturns = returnsR.status === 'fulfilled' ? returnsR.value.filter((r) => /fbo/i.test(r.schema)) : [];

  res.json({
    ok: true,
    stocks: { rows: stocks, error: stocksR.status === 'rejected' ? msg(stocksR.reason) : null },
    sold: { rows: Array.from(soldMap.values()).sort((a, b) => b.sold - a.sold), error: postingsR.status === 'rejected' ? msg(postingsR.reason) : null },
    returns: { rows: fboReturns, error: returnsR.status === 'rejected' ? msg(returnsR.reason) : null },
  });
});
