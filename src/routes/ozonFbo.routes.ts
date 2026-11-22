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


/** Статусы FBS «отправлено»: заказ уже передан Ozon (в доставке, доставлен, спор). Отменённые и ещё не отгруженные — нет. */
const SHIPPED_STATUSES = ['delivering', 'delivered', 'arbitration', 'client_arbitration', 'driver_pickup', 'sent_by_seller'];

/**
 * GET /api/ozon-fbo/shipped?from=&to= — сколько товаров отправили на Ozon (FBS) за период, по каждому товару:
 * штук, закуп (себестоимость), продажа, расходы Ozon (комиссия, логистика, последняя миля, эквайринг), налог, чистая прибыль.
 * Если Ozon ещё не начислил комиссию (заказ в доставке) — расходы оцениваем по тарифам из карточки товара (помечено «≈»).
 */
ozonFboRouter.get('/shipped', async (req, res) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const dateTo = to ? almatyEndOfDay(to) : new Date();
    const dateFrom = from ? almatyStartOfDay(from) : new Date(dateTo.getTime() - 30 * 24 * 3600 * 1000);
    const taxPct = await getTaxRatePct().catch(() => 4);
    const orders: any[] = await prisma.order.findMany({
      where: { marketplace: 'OZON', status: { in: SHIPPED_STATUSES }, orderDate: { gte: dateFrom, lte: dateTo } },
      include: { items: true },
    });
    const skus = Array.from(new Set(orders.flatMap((o) => (o.items ?? []).map((i: any) => String(i.externalSku)))));
    const products: any[] = skus.length ? await prisma.product.findMany({
      where: { OR: [{ ozonOfferId: { in: skus } }, { sku: { in: skus } }] },
      select: { sku: true, ozonOfferId: true, name: true, costPrice: true, packagingCost: true, ozonCommissionRatePct: true, ozonLogisticsAmount: true, ozonLastMileAmount: true, ozonAcquiringAmount: true },
    }) : [];
    const byOffer = new Map<string, any>();
    for (const p of products) { if (p.ozonOfferId) byOffer.set(String(p.ozonOfferId), p); if (!byOffer.has(p.sku)) byOffer.set(p.sku, p); }

    type Agg = { offerId: string; name: string; qty: number; orders: Set<string>; revenue: number; cogs: number; fees: number; tax: number; noCost: boolean; estimated: boolean };
    const agg = new Map<string, Agg>();
    for (const o of orders) {
      const items: any[] = o.items ?? [];
      const realFees = (o.marketplaceCommission || 0) + (o.logisticsCost || 0) + (o.acquiringCost || 0) + (o.otherFees || 0);
      const itemsSum = items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 0), 0);
      const revenueOrder = o.totalRevenue || itemsSum;
      for (const i of items) {
        const pr = byOffer.get(String(i.externalSku));
        const qty = i.quantity || 0;
        const share = itemsSum > 0 ? ((i.price || 0) * qty) / itemsSum : 1 / Math.max(1, items.length);
        const rev = revenueOrder * share;
        const unitCost = i.costPrice || pr?.costPrice || 0;
        const cogs = (unitCost + (pr?.packagingCost || 0)) * qty;
        const estimated = !(realFees > 0);
        const fees = !estimated
          ? realFees * share
          : pr ? (rev * (pr.ozonCommissionRatePct || 0)) / 100 + ((pr.ozonLogisticsAmount || 0) + (pr.ozonLastMileAmount || 0) + (pr.ozonAcquiringAmount || 0)) * qty : 0;
        const key = String(i.externalSku || i.name);
        const a = agg.get(key) ?? { offerId: String(i.externalSku || ''), name: i.name || pr?.name || key, qty: 0, orders: new Set<string>(), revenue: 0, cogs: 0, fees: 0, tax: 0, noCost: false, estimated: false };
        a.qty += qty; a.orders.add(o.externalId); a.revenue += rev; a.cogs += cogs; a.fees += fees; a.tax += (rev * taxPct) / 100;
        if (!unitCost) a.noCost = true;
        if (estimated) a.estimated = true;
        agg.set(key, a);
      }
    }
    const r0 = (n: number) => Math.round(n);
    const rows = Array.from(agg.values()).map((a) => ({
      offerId: a.offerId, name: a.name, qty: a.qty, orders: a.orders.size,
      revenue: r0(a.revenue), cogs: r0(a.cogs), fees: r0(a.fees), tax: r0(a.tax),
      profit: r0(a.revenue - a.cogs - a.fees - a.tax), noCost: a.noCost, estimated: a.estimated,
    })).sort((x, y) => y.qty - x.qty || y.revenue - x.revenue);
    const sum = (k: 'qty' | 'revenue' | 'cogs' | 'fees' | 'tax' | 'profit') => rows.reduce((s, r) => s + r[k], 0);
    res.json({
      ok: true, taxPct, rows,
      totals: { orders: orders.length, qty: sum('qty'), revenue: sum('revenue'), cogs: sum('cogs'), fees: sum('fees'), tax: sum('tax'), profit: sum('profit'), noCost: rows.filter((r) => r.noCost).length },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: msg(err) });
  }
});
