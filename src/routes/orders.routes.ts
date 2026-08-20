import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@/db/prisma';
import { kaspiClient } from '@/integrations/kaspi.client';
import { MarketplaceName } from '@/types';

export const ordersRouter = Router();

// Группы статусов Kaspi для вкладок-фильтров (как в кабинете Kaspi/Northline).
// Точные названия статусов в API Kaspi могут отличаться в отдельных случаях —
// если какой-то статус не попадает ни в одну вкладку, он просто не проходит фильтр.
const STATUS_GROUPS: Record<string, string[]> = {
  preorder: ['NEW', 'SIGN_REQUIRED', 'APPROVED_BY_BANK'],
  packing: ['ACCEPTED_BY_MERCHANT'],
  handover: ['ASSEMBLE'],
  delivering: ['COMPLETED'],
  cancelled: ['CANCELLED', 'CANCELLING', 'RETURNED'],
};

ordersRouter.get('/meta', async (_req, res) => {
  const [cities, deliveryTypes] = await Promise.all([
    prisma.order.findMany({ where: { city: { not: null } }, distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' } }),
    prisma.order.findMany({ where: { deliveryType: { not: null } }, distinct: ['deliveryType'], select: { deliveryType: true }, orderBy: { deliveryType: 'asc' } }),
  ]);
  res.json({
    cities: cities.map((c) => c.city).filter(Boolean),
    deliveryTypes: deliveryTypes.map((d) => d.deliveryType).filter(Boolean),
  });
});

ordersRouter.get('/', async (req, res) => {
  const { from, to, marketplace, page = '1', pageSize = '50', city, deliveryType, statusGroup, search } = req.query as Record<string, string>;

  const where: any = {};
  if (from || to) {
    where.orderDate = {};
    if (from) where.orderDate.gte = new Date(from);
    if (to) where.orderDate.lte = new Date(to);
  }
  if (marketplace) where.marketplace = marketplace as MarketplaceName;
  if (city) where.city = city;
  if (deliveryType) where.deliveryType = deliveryType;
  if (statusGroup && STATUS_GROUPS[statusGroup]) where.status = { in: STATUS_GROUPS[statusGroup] };
  if (search) {
    where.OR = [
      { externalId: { contains: search } },
      { items: { some: { name: { contains: search } } } },
    ];
  }

  const take = Math.min(Number(pageSize) || 50, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: true },
      orderBy: { orderDate: 'desc' },
      take,
      skip,
    }),
    prisma.order.count({ where }),
  ]);

  res.json({ orders, total, page: Number(page) || 1, pageSize: take });
});

ordersRouter.get('/:id', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: { include: { product: true } } },
  });
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  res.json(order);
});

// Принять новый заказ Kaspi (перевести в статус ACCEPTED_BY_MERCHANT).
ordersRouter.post('/:id/accept', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.marketplace !== 'KASPI') return res.status(400).json({ error: 'Действие доступно только для заказов Kaspi' });
  if (!order.kaspiInternalId) return res.status(400).json({ error: 'У заказа нет внутреннего id Kaspi — пересинхронизируйте заказы' });

  try {
    await kaspiClient.acceptOrder(order.kaspiInternalId, order.externalId);
    const updated = await prisma.order.update({ where: { id: order.id }, data: { status: 'ACCEPTED_BY_MERCHANT' } });
    res.json({ ok: true, order: updated });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.response?.data ?? err?.message ?? err) });
  }
});

// Сформировать накладную для передачи заказа на Kaspi Доставку (статус ASSEMBLE).
// Печатную накладную нужно будет скачать в личном кабинете Kaspi — API её не отдаёт,
// этот запрос только переводит заказ в статус, при котором накладная там появляется.
ordersRouter.post('/:id/waybill', async (req, res) => {
  const schema = z.object({ numberOfSpace: z.number().int().positive().default(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.marketplace !== 'KASPI') return res.status(400).json({ error: 'Действие доступно только для заказов Kaspi' });
  if (!order.kaspiInternalId) return res.status(400).json({ error: 'У заказа нет внутреннего id Kaspi — пересинхронизируйте заказы' });

  try {
    await kaspiClient.formWaybill(order.kaspiInternalId, parsed.data.numberOfSpace);
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'ASSEMBLE', numberOfSpace: parsed.data.numberOfSpace, waybillGeneratedAt: new Date() },
    });
    res.json({ ok: true, order: updated });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.response?.data ?? err?.message ?? err) });
  }
});
