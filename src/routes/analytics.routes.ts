import { Router } from 'express';
import dayjs from 'dayjs';
import { getByCategory, getByProduct, getSummary, getSummaryByMarketplace, getTimeseries, getProductForecasts } from '../services/analytics.service';
import { getTaxRatePct } from '../handlers/taxSettings';
import { MarketplaceName } from '../types';

export const analyticsRouter = Router();

function parseRange(query: Record<string, string>) {
  const to = query.to ? dayjs(query.to).endOf('day').toDate() : dayjs().endOf('day').toDate();
  const from = query.from ? dayjs(query.from).startOf('day').toDate() : dayjs(to).subtract(30, 'day').startOf('day').toDate();
  const marketplace = query.marketplace as MarketplaceName | undefined;
  return { from, to, marketplace };
}

analyticsRouter.get('/summary', async (req, res) => {
  const range = parseRange(req.query as Record<string, string>);
  const taxRatePct = await getTaxRatePct();
  const summary = range.marketplace ? await getSummary(range, taxRatePct) : await getSummaryByMarketplace(range, taxRatePct);
  res.json(summary);
});

analyticsRouter.get('/by-product', async (req, res) => {
  const range = parseRange(req.query as Record<string, string>);
  const taxRatePct = await getTaxRatePct();
  const data = await getByProduct(range, taxRatePct);
  res.json(data);
});

analyticsRouter.get('/by-category', async (req, res) => {
  const range = parseRange(req.query as Record<string, string>);
  const data = await getByCategory(range);
  res.json(data);
});

analyticsRouter.get('/timeseries', async (req, res) => {
  const range = parseRange(req.query as Record<string, string>);
  const groupBy = (req.query.groupBy as 'day' | 'week' | 'month') || 'day';
  const data = await getTimeseries(range, groupBy);
  res.json(data);
});

/**
 * Прогнозная юнит-экономика по каталогу — не зависит от периода/фильтра
 * дат (это оценка "сейчас", а не отчёт за период) — см. analytics.service.ts.
 */
analyticsRouter.get('/forecast', async (_req, res) => {
  const taxRatePct = await getTaxRatePct();
  const data = await getProductForecasts(taxRatePct);
  res.json(data);
});
