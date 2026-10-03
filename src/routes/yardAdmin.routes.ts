import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { yardApplyPayment, yardApplyAccept, yardApplyClose, YardTransitionError } from '../services/yard.service';

export const yardAdminRouter = Router();

/** Магазины «Двора» — для вкладки «Магазины». */
yardAdminRouter.get('/shops', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const shops = await prisma.yardShop.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(shops);
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] GET /shops упал');
    res.status(500).json({ error: 'Не удалось получить магазины двора', details: String(err?.message ?? err) });
  }
});

const subscriptionSchema = z.object({
  // Либо прямая дата (админ сам решает), либо продление на N месяцев от
  // max(сейчас, текущий paidUntil) — удобнее для «продлить ещё на месяц».
  paidUntil: z.string().datetime().optional(),
  months: z.number().int().positive().optional(),
}).refine((d) => d.paidUntil || d.months, { message: 'Укажите paidUntil или months' });

/** Подписка 500 ₸/мес — вручную, админ сам проставляет paidUntil. */
yardAdminRouter.post('/shops/:id/subscription', async (req, res) => {
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const shop = await prisma.yardShop.findUnique({ where: { id: req.params.id } });
    if (!shop) return res.status(404).json({ error: 'Магазин не найден' });

    let paidUntil: Date;
    if (parsed.data.paidUntil) {
      paidUntil = new Date(parsed.data.paidUntil);
    } else {
      const base = shop.paidUntil && shop.paidUntil.getTime() > Date.now() ? shop.paidUntil : new Date();
      paidUntil = new Date(base.getTime() + parsed.data.months! * 30 * 24 * 60 * 60 * 1000);
    }
    const updated = await prisma.yardShop.update({ where: { id: req.params.id }, data: { paidUntil } });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /shops/:id/subscription упал');
    res.status(500).json({ error: 'Не удалось продлить подписку', details: String(err?.message ?? err) });
  }
});

const toggleActiveSchema = z.object({ active: z.boolean() });

/** Включить/выключить магазин вручную (отдельно от подписки). */
yardAdminRouter.post('/shops/:id/active', async (req, res) => {
  const parsed = toggleActiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const updated = await prisma.yardShop.update({ where: { id: req.params.id }, data: { active: parsed.data.active } });
    res.json(updated);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Магазин не найден' });
    logger.error({ err }, '[Yard Admin] POST /shops/:id/active упал');
    res.status(500).json({ error: 'Не удалось изменить статус магазина', details: String(err?.message ?? err) });
  }
});

/** Все полки разом — для вкладки «Полки», с именем магазина для контекста. */
yardAdminRouter.get('/items', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const items = await prisma.yardItem.findMany({ include: { shop: { select: { name: true, kind: true } } } });
    res.json(items);
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] GET /items упал');
    res.status(500).json({ error: 'Не удалось получить товары двора', details: String(err?.message ?? err) });
  }
});

/**
 * Все заказы разом — для вкладки «Заказы». Скрин чека — последнее сообщение
 * с imageUrl в чате заказа (не отдельное поле на YardOrder — схема его не
 * предусматривает, чек идёт через YardMessage).
 */
yardAdminRouter.get('/orders', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const orders = await prisma.yardOrder.findMany({
      include: { items: true, shop: { select: { name: true, phone: true, kind: true } }, messages: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(
      orders.map((o: any) => ({
        ...o,
        receiptUrl: [...o.messages].reverse().find((m: any) => m.imageUrl)?.imageUrl ?? null,
      })),
    );
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] GET /orders упал');
    res.status(500).json({ error: 'Не удалось получить заказы двора', details: String(err?.message ?? err) });
  }
});

/**
 * Оборот двора — отдельно от юнит-экономики APP: комиссия 0, налог не
 * считаем (деньги идут покупатель -> магазин напрямую, эквайринга ещё нет).
 * Эта цифра нигде не подмешивается в существующие финансовые расчёты APP.
 */
yardAdminRouter.get('/turnover', async (_req, res) => {
  try {
    const paidStatuses = ['paid', 'accepted', 'at_door', 'done'];
    const orders = await prisma.yardOrder.findMany({ where: { status: { in: paidStatuses } }, select: { total: true } });
    const total = orders.reduce((sum: number, o: { total: number }) => sum + o.total, 0);
    res.json({ turnover: total, orderCount: orders.length, commission: 0 });
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] GET /turnover упал');
    res.status(500).json({ error: 'Не удалось посчитать оборот двора', details: String(err?.message ?? err) });
  }
});

/** Те же действия, что у продавца, но без привязки к телефону — админ может за любой магазин. */
const paymentSchema = z.object({ ok: z.boolean() });
yardAdminRouter.post('/orders/:id/payment', async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const order = await yardApplyPayment(req.params.id, parsed.data.ok);
    res.json(order);
  } catch (err: any) {
    if (err instanceof YardTransitionError) return res.status(err.status).json({ error: err.message });
    logger.error({ err }, '[Yard Admin] POST /orders/:id/payment упал');
    res.status(500).json({ error: 'Не удалось отметить оплату', details: String(err?.message ?? err) });
  }
});

yardAdminRouter.post('/orders/:id/accept', async (req, res) => {
  try {
    const order = await yardApplyAccept(req.params.id);
    res.json(order);
  } catch (err: any) {
    if (err instanceof YardTransitionError) return res.status(err.status).json({ error: err.message });
    logger.error({ err }, '[Yard Admin] POST /orders/:id/accept упал');
    res.status(500).json({ error: 'Не удалось принять заказ', details: String(err?.message ?? err) });
  }
});

const closeSchema = z.object({ status: z.enum(['done', 'not_picked', 'out_of_stock']) });
yardAdminRouter.post('/orders/:id/close', async (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const order = await yardApplyClose(req.params.id, parsed.data.status);
    res.json(order);
  } catch (err: any) {
    if (err instanceof YardTransitionError) return res.status(err.status).json({ error: err.message });
    logger.error({ err }, '[Yard Admin] POST /orders/:id/close упал');
    res.status(500).json({ error: 'Не удалось закрыть заказ', details: String(err?.message ?? err) });
  }
});
