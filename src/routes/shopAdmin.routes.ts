import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

export const shopAdminRouter = Router();

/**
 * Статистика для вкладки «Главная» My Market — ТОЛЬКО данные ShopOrder
 * (канал APP), никогда не подмешивает заказы Kaspi/Ozon/WB. Возврат
 * пока считается по статусу "cancelled" на уровне ShopOrder — отдельной
 * модели возвратов в этой версии нет, честно так и считаем (не выдумываем
 * более сложную модель возвратов сверх того, что реально есть).
 */
shopAdminRouter.get('/dashboard', async (_req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 13); // включая сегодня — 14 дней
    since.setHours(0, 0, 0, 0);

    const orders = await prisma.shopOrder.findMany({ where: { createdAt: { gte: since } } });

    // График по дням — считаем по дате СОЗДАНИЯ заказа (это ближе к "заказано",
    // а не к дате оплаты/выдачи).
    const byDay = new Map<string, { count: number; revenue: number }>();
    for (let i = 0; i < 14; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      byDay.set(d.toISOString().slice(0, 10), { count: 0, revenue: 0 });
    }
    for (const o of orders) {
      const key = o.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(key);
      if (bucket) {
        bucket.count += 1;
        bucket.revenue += o.total;
      }
    }

    const allOrders = await prisma.shopOrder.findMany();
    const totalRevenue = allOrders.reduce((sum, o) => sum + o.total, 0);
    const totalItems = allOrders.reduce((sum, o) => {
      try {
        const items = JSON.parse(o.items) as Array<{ quantity: number }>;
        return sum + items.reduce((s, i) => s + i.quantity, 0);
      } catch {
        return sum;
      }
    }, 0);

    res.json({
      chart: Array.from(byDay.entries()).map(([date, v]) => ({ date, ...v })),
      totalRevenue,
      totalItems,
      awaitingAssembly: allOrders.filter((o) => o.status === 'paid').length,
      inDelivery: allOrders.filter((o) => o.status === 'assembled').length,
      delivered: allOrders.filter((o) => o.status === 'delivered').length,
      cancelled: allOrders.filter((o) => o.status === 'cancelled').length,
    });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /dashboard упал');
    res.status(500).json({ error: 'Не удалось получить статистику', details: String(err?.message ?? err) });
  }
});

// Список заказов приложения — для вкладки «My Market» в админке.
// Число отзывов по списку sku разом — для колонки "Отзывы" в таблице
// товаров My Market (без x-app-key, это админский путь).
shopAdminRouter.get('/reviews-count', async (req, res) => {
  try {
    const skusParam = String(req.query.skus ?? '');
    const skus = skusParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (!skus.length) return res.json({});
    const grouped = await prisma.shopReview.groupBy({ by: ['sku'], where: { sku: { in: skus } }, _count: { sku: true } });
    const result: Record<string, number> = {};
    grouped.forEach((g) => { result[g.sku] = g._count.sku; });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось получить число отзывов', details: String(err?.message ?? err) });
  }
});

shopAdminRouter.get('/orders', async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const orders = await prisma.shopOrder.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json(orders.map((o) => ({ ...o, items: JSON.parse(o.items) })));
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /orders упал');
    res.status(500).json({ error: 'Не удалось получить заказы', details: String(err?.message ?? err) });
  }
});

shopAdminRouter.get('/orders/:id', async (req, res) => {
  try {
    const order = await prisma.shopOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    res.json({ ...order, items: JSON.parse(order.items) });
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось получить заказ', details: String(err?.message ?? err) });
  }
});

const statusSchema = z.object({ status: z.enum(['pending_payment', 'paid', 'assembled', 'delivered', 'cancelled']) });

// Ручная смена статуса из админки (например, "assembled" — товар собран,
// готов к выдаче; "cancelled" — отмена). Оплата (-> paid) и выдача
// (-> delivered) обычно идут через свои специализированные эндпоинты
// (/api/shop/orders/:id/paid и /api/courier/deliver), но этот путь
// оставлен для ручной корректировки статуса из админки при необходимости.
shopAdminRouter.post('/orders/:id/status', async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const order = await prisma.shopOrder.update({ where: { id: req.params.id }, data: { status: parsed.data.status } });
    res.json(order);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось изменить статус заказа', details: String(err?.message ?? err) });
  }
});

/**
 * Массовая загрузка Excel — ТОЛЬКО для витрины My Market, отдельно от
 * общей загрузки товаров (там другие обязательные поля и другой смысл).
 * Обязательные колонки: sku, name, category, type — строка без category
 * ИЛИ type целиком отклоняется (не загружается, не "чинится" дефолтом).
 */
const shopBulkRowSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  subcategory: z.string().optional().nullable(),
  type: z.string().min(1),
  shopPrice: z.number().nonnegative().optional().nullable(),
  shopOldPrice: z.number().nonnegative().optional().nullable(),
  shopStock: z.number().int().nonnegative().default(0),
  description: z.string().optional().nullable(),
  composition: z.string().optional().nullable(),
  images: z.string().optional().nullable(),
  shopDelivery: z.string().optional().nullable(),
  shopActive: z.boolean().default(true),
});

shopAdminRouter.post('/bulk-upsert', async (req, res) => {
  const bodySchema = z.object({ products: z.array(z.record(z.any())).min(1).max(2000) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверный формат данных', details: parsed.error.flatten() });

  let created = 0;
  let updated = 0;
  const errors: string[] = [];

  for (const raw of parsed.data.products) {
    const row = shopBulkRowSchema.safeParse(raw);
    if (!row.success) {
      // Строка без category или type (или sku/name) — явная ошибка по строке,
      // не загружаем её, но продолжаем обрабатывать остальные.
      errors.push(`${raw.sku ?? '(без sku)'}: ${JSON.stringify(row.error.flatten().fieldErrors)}`);
      continue;
    }
    try {
      const existing = await prisma.product.findFirst({ where: { sku: row.data.sku } });
      const data = {
        name: row.data.name,
        category: row.data.category,
        subcategory: row.data.subcategory || null,
        type: row.data.type,
        shopPrice: row.data.shopPrice ?? null,
        shopOldPrice: row.data.shopOldPrice ?? null,
        shopStock: row.data.shopStock,
        description: row.data.description || null,
        composition: row.data.composition || null,
        images: row.data.images || null,
        shopDelivery: row.data.shopDelivery || null,
        shopActive: row.data.shopActive,
      };
      if (existing) {
        await prisma.product.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await prisma.product.create({ data: { sku: row.data.sku, costPrice: 0, ...data } });
        created += 1;
      }
    } catch (err: any) {
      errors.push(`${row.data.sku}: ${String(err?.message ?? err)}`);
    }
  }

  res.json({ ok: true, created, updated, errors });
});
