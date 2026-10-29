import { Router } from 'express';
import { ozonClient } from '../integrations/ozon.client';
import { almatyStartOfDay, almatyEndOfDay } from '../utils/timezone';
import { logger } from '../utils/logger';

export const ozonReturnsRouter = Router();

/** GET /api/ozon-returns?from=YYYY-MM-DD&to=YYYY-MM-DD — возвраты Ozon напрямую из API (без записи в базу). */
ozonReturnsRouter.get('/', async (req, res) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const dateTo = to ? almatyEndOfDay(to) : new Date();
    const dateFrom = from ? almatyStartOfDay(from) : new Date(dateTo.getTime() - 60 * 24 * 3600 * 1000);
    const returns = await ozonClient.fetchReturns(dateFrom, dateTo);
    res.json({ ok: true, total: returns.length, returns });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка загрузки возвратов Ozon');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});
