import { Router } from 'express';
import dayjs from 'dayjs';
import { z } from 'zod';
import { getGoogleTrends, getMySalesByKeyword, TRENDS_REGIONS } from '../services/searchAnalytics.service';
import { getWordstatTop, WORDSTAT_REGIONS } from '../services/wordstat.service';
import { logger } from '../utils/logger';

export const searchAnalyticsRouter = Router();

const keywordSchema = z.string().trim().min(2, 'Введите слово (минимум 2 символа)').max(80);

searchAnalyticsRouter.get('/regions', (_req, res) => {
  res.json(Object.entries(TRENDS_REGIONS).map(([code, label]) => ({ code, label })));
});

/** Продажи своих товаров по слову: ?q=куртка&from=2026-01-01&to=2026-10-31 */
searchAnalyticsRouter.get('/my-sales', async (req, res) => {
  const q = keywordSchema.safeParse(req.query.q);
  if (!q.success) return res.status(400).json({ error: q.error.issues[0].message });
  const to = req.query.to ? new Date(String(req.query.to) + 'T23:59:59') : new Date();
  const from = req.query.from ? new Date(String(req.query.from) + 'T00:00:00') : dayjs(to).subtract(11, 'month').startOf('month').toDate();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: 'Неверная дата' });
  if (dayjs(to).diff(from, 'month') > 36) return res.status(400).json({ error: 'Период не больше 36 месяцев' });
  try {
    res.json(await getMySalesByKeyword(q.data, from, to));
  } catch (err: any) {
    logger.error({ err }, '[Аналитика запросов] Ошибка «Мои продажи»');
    res.status(500).json({ error: 'Не удалось посчитать продажи', details: String(err?.message ?? err) });
  }
});

/** Google Trends: ?q=куртка&geo=KZ-ALA&months=12 */
searchAnalyticsRouter.get('/google-trends', async (req, res) => {
  const q = keywordSchema.safeParse(req.query.q);
  if (!q.success) return res.status(400).json({ error: q.error.issues[0].message });
  const geo = String(req.query.geo || 'KZ');
  if (!(geo in TRENDS_REGIONS)) return res.status(400).json({ error: 'Неизвестный регион' });
  const months = Number(req.query.months) || 12;
  try {
    res.json(await getGoogleTrends(q.data, geo, months));
  } catch (err: any) {
    logger.warn({ err }, '[Аналитика запросов] Google Trends недоступен');
    res.status(502).json({ error: 'Google Trends не ответил', details: String(err?.message ?? err) });
  }
});

/** Яндекс Wordstat: ?q=куртка&geo=KZ-ALA — топ запросов со словом (Yandex Search API). */
searchAnalyticsRouter.get('/wordstat', async (req, res) => {
  const q = keywordSchema.safeParse(req.query.q);
  if (!q.success) return res.status(400).json({ error: q.error.issues[0].message });
  const geo = String(req.query.geo || 'KZ');
  if (!(geo in WORDSTAT_REGIONS)) return res.status(400).json({ error: 'Для Wordstat этот регион пока не подключён' });
  try {
    res.json(await getWordstatTop(q.data, geo));
  } catch (err: any) {
    logger.warn({ err }, '[Аналитика запросов] Wordstat недоступен');
    res.status(502).json({ error: 'Wordstat не ответил', details: String(err?.message ?? err) });
  }
});
