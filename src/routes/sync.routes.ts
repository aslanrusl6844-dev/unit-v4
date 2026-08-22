import { Router } from 'express';
import dayjs from 'dayjs';
import { prisma } from '../db/prisma';
import { syncKaspiOrders, syncOzonOrders, syncWbOrders } from '../services/sync.service';
import { kaspiClient } from '../integrations/kaspi.client';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const syncRouter = Router();

syncRouter.post('/kaspi', async (req, res) => {
  const { dateFrom, dateTo } = resolveRange(req.query);
  try {
    const result = await syncKaspiOrders(dateFrom, dateTo);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка ручной синхронизации Kaspi');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/** Явные from/to (ISO-даты) — так фронтенд может сам резать большой период
 *  на маленькие куски и звать этот эндпоинт несколько раз подряд, вместо
 *  того чтобы просить сервер сделать всё за один HTTP-запрос (который на
 *  serverless легко упирается в лимит времени). Если from/to не переданы —
 *  используется старое поведение через ?days=N. */
function resolveRange(query: Record<string, any>): { dateFrom: Date; dateTo: Date } {
  if (query.from && query.to) {
    return { dateFrom: new Date(String(query.from)), dateTo: new Date(String(query.to)) };
  }
  const days = Number(query.days) || 7;
  const dateTo = new Date();
  const dateFrom = dayjs(dateTo).subtract(days, 'day').toDate();
  return { dateFrom, dateTo };
}

syncRouter.post('/ozon', async (req, res) => {
  const { dateFrom, dateTo } = resolveRange(req.query);
  try {
    const result = await syncOzonOrders(dateFrom, dateTo);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка ручной синхронизации Ozon');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

syncRouter.post('/wb', async (req, res) => {
  const { dateFrom, dateTo } = resolveRange(req.query);
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
    kaspi: { configured: await kaspiClient.isConfigured() },
    ozon: { configured: env.ozon.isConfigured },
    wb: { configured: env.wb.isConfigured },
    cron: env.sync.cron,
  });
});
