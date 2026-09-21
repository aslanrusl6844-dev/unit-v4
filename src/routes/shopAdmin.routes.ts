import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

export const shopAdminRouter = Router();

// Список заказов приложения — для вкладки «My Market» в админке.
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
