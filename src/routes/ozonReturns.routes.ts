import { Router } from 'express';
import { ozonClient } from '../integrations/ozon.client';
import { almatyStartOfDay, almatyEndOfDay } from '../utils/timezone';
import { logger } from '../utils/logger';

export const ozonReturnsRouter = Router();

/**
 * GET /api/ozon-returns/pickup — ВСЕ возвраты Ozon (без периода), разложенные для забора:
 *  - ready: уже лежат на складе возвратов в Алматы (place = АЛМАТЫ_..._ВОЗВРАТЫ, Ельтай) — забрать;
 *  - coming: едут туда (target_place = АЛМАТЫ_..._ВОЗВРАТЫ, а place — другой склад).
 * Сроки платного хранения и утилизации — из блока storage Ozon.
 */
ozonReturnsRouter.get('/pickup', async (_req, res) => {
  try {
    const all = await ozonClient.fetchReturns(null, null);
    const isAlmatyReturns = (name: string) => /алматы/i.test(name) && /возврат/i.test(name);
    // Уже забранные/завершённые возвраты не показываем.
    const finished = (r: { status: string; statusSysName: string }) =>
      /returned_to_seller|utiliz|dispos/i.test(r.statusSysName) || /выдан продавцу|вручен продавцу|утилизир/i.test(r.status);
    const ready = all.filter((r) => isAlmatyReturns(r.placeName) && !finished(r));
    const coming = all.filter((r) => !isAlmatyReturns(r.placeName) && isAlmatyReturns(r.targetPlaceName) && !finished(r));
    logger.info({ total: all.length, ready: ready.map((r) => [r.postingNumber, r.offerId, r.placeName, r.statusSysName]), coming: coming.map((r) => [r.postingNumber, r.offerId, r.placeName, r.targetPlaceName]), sampleStorage: ready[0]?.storage ?? null }, '[Ozon] Возвраты к забору');
    res.json({ ok: true, total: all.length, ready, coming });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка возвратов Ozon к забору');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

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
