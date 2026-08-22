import { Router } from 'express';
import dayjs from 'dayjs';
import { prisma } from '../db/prisma';
import { syncKaspiOrders, syncOzonOrders, syncWbOrders } from '../services/sync.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const syncRouter = Router();

syncRouter.post('/kaspi', async (req, res) => {
  const days = Number(req.query.days) || 7;
  const dateTo = new Date();
  const dateFrom = dayjs(dateTo).subtract(days, 'day').toDate();
  try {
    const result = await syncKaspiOrders(dateFrom, dateTo);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка ручной синхронизации Kaspi');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

syncRouter.post('/ozon', async (req, res) => {
  const days = Number(req.query.days) || 7;
  const dateTo = new Date();
  const dateFrom = dayjs(dateTo).subtract(days, 'day').toDate();
  try {
    const result = await syncOzonOrders(dateFrom, dateTo);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка ручной синхронизации Ozon');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

syncRouter.post('/wb', async (req, res) => {
  const days = Number(req.query.days) || 7;
  const dateTo = new Date();
  const dateFrom = dayjs(dateTo).subtract(days, 'day').toDate();
  try {
    const result = await syncWbOrders(dateFrom, dateTo);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка ручной синхронизации Wildberries');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

syncRouter.get('/logs', async (_req, res) => {
  const logs = await prisma.syncLog.findMany({ orderBy: { startedAt: 'desc' }, take: 30 });
  res.json(logs);
});

syncRouter.get('/status', async (_req, res) => {
  res.json({
    kaspi: { configured: env.kaspi.isConfigured },
    ozon: { configured: env.ozon.isConfigured },
    wb: { configured: env.wb.isConfigured },
    cron: env.sync.cron,
  });
});
