import { Router } from 'express';
import dayjs from 'dayjs';
import { getByProduct, getSummary, getSummaryByMarketplace, getTimeseries } from '../services/analytics.service';
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
  const summary = range.marketplace ? await getSummary(range) : await getSummaryByMarketplace(range);
  res.json(summary);
});

analyticsRouter.get('/by-product', async (req, res) => {
  const range = parseRange(req.query as Record<string, string>);
  const data = await getByProduct(range);
  res.json(data);
});

analyticsRouter.get('/timeseries', async (req, res) => {
  const range = parseRange(req.query as Record<string, string>);
  const groupBy = (req.query.groupBy as 'day' | 'week' | 'month') || 'day';
  const data = await getTimeseries(range, groupBy);
  res.json(data);
});
