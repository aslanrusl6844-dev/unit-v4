import { Router } from 'express';
import dayjs from 'dayjs';
import { prisma } from '../db/prisma';
import { syncTeezOrders, syncTeezCatalog } from '../services/teezSync.service';
import { teezClient } from '../integrations/teez.client';
import { syncKaspiOrders, syncOzonOrders, syncWbOrders, syncOzonCatalog, syncOzonPrices, syncWbCatalog, syncKaspiPhotos, syncOzonContent } from '../services/sync.service';
import { kaspiClient } from '../integrations/kaspi.client';
import { ozonClient } from '../integrations/ozon.client';
import { wbClient } from '../integrations/wb.client';
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

syncRouter.post('/teez', async (req, res) => {
  const { dateFrom, dateTo } = resolveRange(req.query);
  try {
    const result = await syncTeezOrders(dateFrom, dateTo);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка ручной синхронизации Teez');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/** Каталог Tez Market: товары, штрихкоды, цены, фото, остатки — в «Товары». */
syncRouter.post('/teez-catalog', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await syncTeezCatalog()) });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка каталога Teez');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * Синхронизация КАТАЛОГА (не заказов) — подтягивает список товаров,
 * СЕЙЧАС стоящих на продаже, через собственный API площадки. У Kaspi
 * такого метода нет (см. предупреждение в README и в разделе «Товары») —
 * поэтому эндпоинт есть только для Ozon и Wildberries.
 */
/** Только цены и тарифы Ozon (быстро) — для кнопки ↻ Ozon и автообновления. */
/** Начисления Ozon по заказам (комиссия, логистика, к выплате) — для ↻ Ozon и автообновления. */
syncRouter.post('/ozon-accruals', async (req, res) => {
  try {
    const { refreshOzonAccruals } = await import('../services/ozonPayouts.service');
    res.json({ ok: true, ...(await refreshOzonAccruals({ force: req.query.force === '1' })) });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка начислений Ozon');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

syncRouter.post('/ozon-prices', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await syncOzonPrices()) });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка обновления цен Ozon');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/** Цены товара на Ozon прямо сейчас — для окна «Цена на Ozon» в админке. */
syncRouter.get('/ozon-price/:productId', async (req, res) => {
  try {
    const p = await prisma.product.findUnique({ where: { id: req.params.productId }, select: { ozonOfferId: true } });
    if (!p?.ozonOfferId) return res.status(404).json({ error: 'У товара нет offer_id Ozon' });
    const d = await ozonClient.fetchPriceDetails(p.ozonOfferId);
    if (!d) return res.status(404).json({ error: 'Ozon не нашёл товар' });
    res.json(d);
  } catch (err: any) {
    logger.error({ err }, 'Ошибка чтения цены Ozon');
    res.status(500).json({ error: 'Не удалось получить цену с Ozon', details: String(err?.message ?? err) });
  }
});

/**
 * Поменять цену товара на Ozon: { price, oldPrice?, minPrice? }. Юнит-экономика считается
 * только от цены продажи (ozonReferencePrice) — её сразу записываем, дальше её уточнит
 * автосверка цен Ozon (каждые 5 минут, с учётом акций).
 */
syncRouter.post('/ozon-price/:productId', async (req, res) => {
  const price = Number(req.body?.price);
  const oldPrice = req.body?.oldPrice == null || req.body.oldPrice === '' ? 0 : Number(req.body.oldPrice);
  const minPrice = req.body?.minPrice == null || req.body.minPrice === '' ? undefined : Number(req.body.minPrice);
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'Укажите цену продажи больше 0' });
  if (!Number.isFinite(oldPrice) || oldPrice < 0) return res.status(400).json({ error: 'Старая цена — число от 0' });
  if (oldPrice > 0 && oldPrice <= price) return res.status(400).json({ error: 'Старая (зачёркнутая) цена должна быть больше цены продажи' });
  if (minPrice !== undefined && (!Number.isFinite(minPrice) || minPrice < 0)) return res.status(400).json({ error: 'Минимальная цена — число от 0' });
  if (minPrice !== undefined && minPrice > price) return res.status(400).json({ error: 'Минимальная цена для акций не может быть больше цены продажи' });
  try {
    const p = await prisma.product.findUnique({ where: { id: req.params.productId }, select: { id: true, ozonOfferId: true, name: true } });
    if (!p?.ozonOfferId) return res.status(404).json({ error: 'У товара нет offer_id Ozon' });
    const current = await ozonClient.fetchPriceDetails(p.ozonOfferId).catch(() => null);
    const errors = await ozonClient.updatePrice({ offerId: p.ozonOfferId, price, oldPrice, minPrice, currency: current?.currency });
    if (errors.length) return res.status(422).json({ error: 'Ozon не принял цену', details: errors.join('; ') });
    await prisma.product.update({ where: { id: p.id }, data: { ozonReferencePrice: Math.round(price), ozonReferencePriceUpdatedAt: new Date() } });
    logger.info({ offerId: p.ozonOfferId, price, oldPrice, minPrice }, '[Ozon] цена изменена из админки');
    res.json({ ok: true, price: Math.round(price), oldPrice: Math.round(oldPrice), minPrice: minPrice != null ? Math.round(minPrice) : null });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка смены цены Ozon');
    res.status(500).json({ error: 'Не удалось поменять цену на Ozon', details: String(err?.message ?? err) });
  }
});

/**
 * Массовая смена цен на Ozon для выбранных товаров: { productIds, price?, oldPrice?, minPrice? }.
 * Пустое поле (null) — у каждого товара оставить его текущее значение; oldPrice = 0 — убрать зачёркнутую.
 * Каждый товар проверяется отдельно; не прошедшие проверку не отправляются и возвращаются с причиной.
 */
export function planBulkOzonPrices(
  rows: Array<{ id: string; name: string; offerId: string; cur: { price: number | null; oldPrice: number | null; minPrice: number | null; currency?: string | null } | null }>,
  set: { price: number | null; oldPrice: number | null; minPrice: number | null },
) {
  const send: Array<{ id: string; offerId: string; price: number; oldPrice: number; minPrice?: number; currency?: string | null }> = [];
  const skipped: Array<{ id: string; name: string; reason: string }> = [];
  for (const r of rows) {
    if (!r.cur) { skipped.push({ id: r.id, name: r.name, reason: 'Ozon не нашёл товар' }); continue; }
    const price = set.price ?? r.cur.price ?? 0;
    const oldPrice = set.oldPrice ?? r.cur.oldPrice ?? 0;
    const minPrice = set.minPrice ?? undefined;
    if (!(price > 0)) { skipped.push({ id: r.id, name: r.name, reason: 'нет цены продажи' }); continue; }
    if (oldPrice > 0 && oldPrice <= price) { skipped.push({ id: r.id, name: r.name, reason: `зачёркнутая ${Math.round(oldPrice)} ₸ не больше цены ${Math.round(price)} ₸` }); continue; }
    if (minPrice !== undefined && minPrice > price) { skipped.push({ id: r.id, name: r.name, reason: `минимальная ${Math.round(minPrice)} ₸ больше цены ${Math.round(price)} ₸` }); continue; }
    send.push({ id: r.id, offerId: r.offerId, price, oldPrice, minPrice, currency: r.cur.currency });
  }
  return { send, skipped };
}

syncRouter.post('/ozon-prices-bulk', async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.productIds) ? req.body.productIds.map(String).slice(0, 1000) : [];
  const opt = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const set = { price: opt(req.body?.price), oldPrice: opt(req.body?.oldPrice), minPrice: opt(req.body?.minPrice) };
  if (!ids.length) return res.status(400).json({ error: 'Не выбраны товары' });
  if (set.price == null && set.oldPrice == null && set.minPrice == null) return res.status(400).json({ error: 'Укажите хотя бы одну цену' });
  for (const [k, v] of Object.entries(set)) {
    if (v != null && (!Number.isFinite(v) || v < 0 || (k === 'price' && v === 0))) return res.status(400).json({ error: 'Цены — положительные числа' });
  }
  try {
    const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, ozonOfferId: true } });
    const withOffer = products.filter((p) => p.ozonOfferId);
    const noOffer = products.filter((p) => !p.ozonOfferId).map((p) => ({ id: p.id, name: p.name, reason: 'нет offer_id Ozon' }));
    const current = await ozonClient.fetchPriceDetailsMany(withOffer.map((p) => p.ozonOfferId!));
    const { send, skipped } = planBulkOzonPrices(
      withOffer.map((p) => ({ id: p.id, name: p.name, offerId: p.ozonOfferId!, cur: current.get(p.ozonOfferId!) ?? null })),
      set,
    );
    const results = send.length ? await ozonClient.updatePricesMany(send) : new Map<string, string[]>();
    const ok: string[] = [];
    const failed: Array<{ id: string; name: string; reason: string }> = [];
    const nameById = new Map(products.map((p) => [p.id, p.name]));
    for (const x of send) {
      const errs = results.get(x.offerId) ?? ['нет ответа'];
      if (errs.length) failed.push({ id: x.id, name: nameById.get(x.id) || x.id, reason: errs.join('; ') });
      else ok.push(x.id);
    }
    const now = new Date();
    for (const x of send.filter((s) => ok.includes(s.id))) {
      await prisma.product.update({ where: { id: x.id }, data: { ozonReferencePrice: Math.round(x.price), ozonReferencePriceUpdatedAt: now } });
    }
    logger.info({ count: ok.length, failed: failed.length, set }, '[Ozon] массовая смена цен из админки');
    res.json({ ok: true, updated: ok.length, failed: [...noOffer, ...skipped, ...failed] });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка массовой смены цен Ozon');
    res.status(500).json({ error: 'Не удалось поменять цены на Ozon', details: String(err?.message ?? err) });
  }
});

syncRouter.post('/ozon-catalog', async (_req, res) => {
  try {
    const result = await syncOzonCatalog();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка синхронизации каталога Ozon');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

syncRouter.post('/wb-catalog', async (_req, res) => {
  try {
    const result = await syncWbCatalog();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка синхронизации каталога Wildberries');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * Фото Kaspi для товаров учёта — пачкой по 5 (см. syncKaspiPhotos). Фронт
 * вызывает повторно, пока remaining не станет 0, передавая в excludeIds
 * товары, которые не удалось прочитать в этом запуске.
 */
syncRouter.post('/kaspi-photos', async (req, res) => {
  try {
    const excludeIds: string[] = Array.isArray(req.body?.excludeIds)
      ? req.body.excludeIds.filter((x: unknown) => typeof x === 'string').slice(0, 500)
      : [];
    const result = await syncKaspiPhotos(5, excludeIds);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка синхронизации фото Kaspi');
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * Описание/состав/фото/категория карточек My Market из Ozon — пачкой по 40
 * с курсором (см. syncOzonContent). Фронт вызывает повторно, пока done=false.
 */
syncRouter.post('/ozon-content', async (req, res) => {
  try {
    const cursor = typeof req.body?.cursor === 'string' && req.body.cursor ? req.body.cursor : undefined;
    const result = await syncOzonContent(40, cursor);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, 'Ошибка синхронизации описаний Ozon');
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
    ozon: { configured: await ozonClient.isConfigured() },
    wb: { configured: await wbClient.isConfigured() },
    teez: { configured: await teezClient.isConfigured() },
    cron: env.sync.cron,
  });
});
