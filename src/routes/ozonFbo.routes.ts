import { Router } from 'express';
import { ozonClient } from '../integrations/ozon.client';
import { almatyStartOfDay, almatyEndOfDay } from '../utils/timezone';
import { prisma } from '../db/prisma';
import { getTaxRatePct } from '../handlers/taxSettings';

export const ozonFboRouter = Router();

const msg = (err: any) => String(err?.message ?? err);

/**
 * GET /api/ozon-fbo?from=&to= — раздел FBO: остатки на складах Ozon и продажи
 * FBO за период (по товарам). Возвраты — отдельная вкладка (/api/ozon-returns). Каждый блок
 * загружается отдельно: ошибка одного не ломает остальные.
 */
ozonFboRouter.get('/', async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const dateTo = to ? almatyEndOfDay(to) : new Date();
  const dateFrom = from ? almatyStartOfDay(from) : new Date(dateTo.getTime() - 30 * 24 * 3600 * 1000);

  const [stocksR, postingsR] = await Promise.allSettled([
    ozonClient.fetchFboStocks(),
    ozonClient.fetchFboPostings(dateFrom, dateTo),
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

  res.json({
    ok: true,
    stocks: { rows: stocks, error: stocksR.status === 'rejected' ? msg(stocksR.reason) : null },
    sold: { rows: Array.from(soldMap.values()).sort((a, b) => b.sold - a.sold), error: postingsR.status === 'rejected' ? msg(postingsR.reason) : null },
  });
});


/**
 * GET /api/ozon-fbo/delivered?from=&to=&scheme= — доставленные (выкупленные) заказы Ozon за период: FBS и FBO.
 * FBS — из нашей базы заказов (реальные комиссии Ozon после начисления), FBO — из Ozon API
 * (комиссия и логистика — оценка по тарифам из карточки товара). Чистая прибыль = цена − себестоимость − комиссии и логистика − налог.
 */
ozonFboRouter.get('/delivered', async (req, res) => {
  const { from, to, scheme } = req.query as Record<string, string>;
  const dateTo = to ? almatyEndOfDay(to) : new Date();
  const dateFrom = from ? almatyStartOfDay(from) : new Date(dateTo.getTime() - 30 * 24 * 3600 * 1000);
  const taxPct = await getTaxRatePct().catch(() => 4);
  const round = (n: number) => Math.round(n);
  type Row = {
    scheme: 'FBS' | 'FBO'; posting: string; date: string | null; name: string; offerId: string; qty: number; price: number;
    revenue: number; cogs: number; fees: number; tax: number; profit: number; noCost: boolean; estimated: boolean;
  };
  const rows: Row[] = [];
  let fboError: string | null = null;

  if (scheme !== 'fbo') {
    const orders = await prisma.order.findMany({
      where: { marketplace: 'OZON', status: 'delivered', orderDate: { gte: dateFrom, lte: dateTo } },
      include: { items: true },
      orderBy: { orderDate: 'desc' },
    });
    for (const o of orders as any[]) {
      const fees = (o.marketplaceCommission || 0) + (o.logisticsCost || 0) + (o.acquiringCost || 0) + (o.otherFees || 0);
      const revenue = o.totalRevenue || 0;
      const items: any[] = o.items ?? [];
      const totalItems = items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 0), 0) || revenue || 1;
      for (const i of items) {
        const part = ((i.price || 0) * (i.quantity || 0)) / totalItems; // доля строки в заказе
        const rev = revenue * part;
        const cogs = (i.costPrice || 0) * (i.quantity || 0);
        const f = fees * part;
        const tax = (rev * taxPct) / 100;
        rows.push({
          scheme: 'FBS', posting: o.externalId, date: o.orderDate?.toISOString?.() ?? null, name: i.name, offerId: i.externalSku,
          qty: i.quantity, price: i.price, revenue: round(rev), cogs: round(cogs), fees: round(f), tax: round(tax),
          profit: round(rev - cogs - f - tax), noCost: !i.costPrice, estimated: o.marketplaceCommission === 0,
        });
      }
    }
  }

  if (scheme !== 'fbs') {
    try {
      const fbo = (await ozonClient.fetchFboPostings(dateFrom, dateTo)).filter((p) => /^delivered$/i.test(p.status));
      const ids = Array.from(new Set(fbo.map((p) => p.offerId).filter(Boolean)));
      const products: any[] = ids.length ? await prisma.product.findMany({
        where: { OR: [{ ozonOfferId: { in: ids } }, { sku: { in: ids } }] },
        select: { sku: true, ozonOfferId: true, costPrice: true, packagingCost: true, ozonCommissionRatePct: true, ozonLogisticsAmount: true, ozonLastMileAmount: true, ozonAcquiringAmount: true },
      }) : [];
      const byOffer = new Map<string, any>();
      for (const p of products) { if (p.ozonOfferId) byOffer.set(p.ozonOfferId, p); if (!byOffer.has(p.sku)) byOffer.set(p.sku, p); }
      for (const p of fbo) {
        const pr = byOffer.get(p.offerId);
        const rev = p.price * p.quantity;
        const cogs = ((pr?.costPrice || 0) + (pr?.packagingCost || 0)) * p.quantity;
        const fees = pr
          ? (rev * (pr.ozonCommissionRatePct || 0)) / 100 + ((pr.ozonLogisticsAmount || 0) + (pr.ozonLastMileAmount || 0) + (pr.ozonAcquiringAmount || 0)) * p.quantity
          : 0;
        const tax = (rev * taxPct) / 100;
        rows.push({
          scheme: 'FBO', posting: p.postingNumber, date: p.createdAt, name: p.name, offerId: p.offerId, qty: p.quantity, price: p.price,
          revenue: round(rev), cogs: round(cogs), fees: round(fees), tax: round(tax), profit: round(rev - cogs - fees - tax),
          noCost: !pr?.costPrice, estimated: true,
        });
      }
    } catch (err) {
      fboError = msg(err);
    }
  }

  rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const sum = (list: Row[]) => ({
    orders: new Set(list.map((r) => r.posting)).size,
    qty: list.reduce((s, r) => s + r.qty, 0),
    revenue: list.reduce((s, r) => s + r.revenue, 0),
    profit: list.reduce((s, r) => s + r.profit, 0),
  });
  res.json({
    ok: true, taxPct, rows, fboError,
    totals: { all: sum(rows), fbs: sum(rows.filter((r) => r.scheme === 'FBS')), fbo: sum(rows.filter((r) => r.scheme === 'FBO')) },
  });
});
