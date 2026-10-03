import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { normalizePhone } from './shop.routes';
import {
  YARD_RADIUS_METERS,
  YARD_PHONE_VISIBLE_STATUSES,
  yardDistanceMeters,
  yardShopIsLive,
  generateYardPublicId,
  yardApplyPayment,
  yardApplyAccept,
  yardApplyClose,
  YardTransitionError,
} from '../services/yard.service';

export const yardRouter = Router();

/**
 * Тот же x-app-key, что и у всего /api/shop/* — «Двор» живёт под тем же
 * приложением покупателя, путь /api/shop/yard/....
 */
yardRouter.use((req, res, next) => {
  if (!env.shopAppKey) {
    return res.status(503).json({ error: 'SHOP_APP_KEY не настроен на сервере — Двор недоступен' });
  }
  const key = req.header('x-app-key');
  if (key !== env.shopAppKey) {
    return res.status(401).json({ error: 'Неверный или отсутствующий заголовок x-app-key' });
  }
  next();
});

function parseLatLng(latRaw: unknown, lngRaw: unknown): { lat: number; lng: number } | null {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Три товара полки для предпросмотра в списке дворов — только активные. */
async function previewItems(shopId: string) {
  return prisma.yardItem.findMany({
    where: { shopId, active: true },
    orderBy: { id: 'asc' },
    take: 3,
    select: { name: true, price: true, photo: true },
  });
}

/**
 * Магазины в радиусе 500 м — имя, вид, метры, 3 товара. БЕЗ телефона.
 * Подписка просрочена/магазин выключен — в список не попадает.
 */
yardRouter.get('/yard/nearby', async (req, res) => {
  const point = parseLatLng(req.query.lat, req.query.lng);
  if (!point) return res.status(400).json({ error: 'Некорректные координаты' });

  try {
    const shops = await prisma.yardShop.findMany({ where: { lat: { not: null }, lng: { not: null } } });
    const nearby = (shops as Array<{ id: string; name: string; kind: string; lat: number | null; lng: number | null; active: boolean; paidUntil: Date | null }>)
      .filter((s) => yardShopIsLive(s))
      .map((s) => ({ ...s, meters: yardDistanceMeters(point.lat, point.lng, s.lat!, s.lng!) }))
      .filter((s) => s.meters <= YARD_RADIUS_METERS)
      .sort((a, b) => a.meters - b.meters);

    const result = await Promise.all(
      nearby.map(async (s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        meters: Math.round(s.meters),
        items: await previewItems(s.id),
      })),
    );
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, '[Yard] GET /yard/nearby упал');
    res.status(500).json({ error: 'Не удалось получить список дворов', details: String(err?.message ?? err) });
  }
});

/** Полка одного магазина — только если точка клиента реально в радиусе. */
yardRouter.get('/yard/shop/:id', async (req, res) => {
  const point = parseLatLng(req.query.lat, req.query.lng);
  if (!point) return res.status(400).json({ error: 'Некорректные координаты' });

  try {
    const shop = await prisma.yardShop.findUnique({ where: { id: req.params.id } });
    if (!shop || !yardShopIsLive(shop)) return res.status(404).json({ error: 'Двор не найден' });
    const distance = yardDistanceMeters(point.lat, point.lng, shop.lat!, shop.lng!);
    if (distance > YARD_RADIUS_METERS) {
      return res.status(403).json({ error: 'Вы вне радиуса 500 м от этого двора' });
    }
    const items = await prisma.yardItem.findMany({ where: { shopId: shop.id, active: true }, orderBy: { id: 'asc' } });
    res.json({
      id: shop.id,
      name: shop.name,
      kind: shop.kind,
      address: shop.address,
      items: items.map((i: { id: string; name: string; price: number; stock: number; photo: string | null }) => ({
        id: i.id,
        name: i.name,
        price: i.price,
        stock: i.stock,
        photo: i.photo,
      })),
    });
  } catch (err: any) {
    logger.error({ err }, '[Yard] GET /yard/shop/:id упал');
    res.status(500).json({ error: 'Не удалось получить полку', details: String(err?.message ?? err) });
  }
});

const createOrderSchema = z.object({
  shopId: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
  buyerPhone: z.string().min(1),
  buyerName: z.string().min(1),
  address: z.string().optional(),
  items: z.array(z.object({ itemId: z.string().min(1), qty: z.number().int().positive() })).min(1),
});

/**
 * Создание заказа — остаток НЕ списываем (только при подтверждении оплаты).
 * Телефон магазина в ответ не кладём. У покупателя кнопки отмены нет —
 * никакого endpoint на отмену заказа в этом файле намеренно нет.
 */
yardRouter.post('/yard/orders', async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });

  const normalizedPhone = normalizePhone(parsed.data.buyerPhone);
  if (!normalizedPhone) return res.status(400).json({ error: 'Некорректный номер телефона' });

  try {
    const shop = await prisma.yardShop.findUnique({ where: { id: parsed.data.shopId } });
    if (!shop || !yardShopIsLive(shop)) return res.status(404).json({ error: 'Двор не найден' });
    const distance = yardDistanceMeters(parsed.data.lat, parsed.data.lng, shop.lat!, shop.lng!);
    if (distance > YARD_RADIUS_METERS) return res.status(403).json({ error: 'Вы вне радиуса 500 м от этого двора' });

    const itemIds = parsed.data.items.map((i) => i.itemId);
    const shelfItems = await prisma.yardItem.findMany({ where: { id: { in: itemIds }, shopId: shop.id, active: true } });
    const shelfById = new Map(shelfItems.map((i: { id: string }) => [i.id, i]));

    const orderItemsData: Array<{ itemId: string; name: string; price: number; qty: number }> = [];
    for (const line of parsed.data.items) {
      const shelfItem = shelfById.get(line.itemId) as { id: string; name: string; price: number; stock: number } | undefined;
      if (!shelfItem) return res.status(400).json({ error: `Товар ${line.itemId} не найден на этой полке` });
      if (shelfItem.stock < line.qty) return res.status(400).json({ error: `На полке недостаточно «${shelfItem.name}»` });
      orderItemsData.push({ itemId: shelfItem.id, name: shelfItem.name, price: shelfItem.price, qty: line.qty });
    }
    const total = orderItemsData.reduce((sum, i) => sum + i.price * i.qty, 0);
    const publicId = await generateYardPublicId();

    const order = await prisma.yardOrder.create({
      data: {
        publicId,
        shopId: shop.id,
        buyerPhone: normalizedPhone,
        buyerName: parsed.data.buyerName,
        address: parsed.data.address,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        total,
        status: 'waiting_payment',
        items: { create: orderItemsData },
      },
      include: { items: true },
    });
    res.status(201).json({
      id: order.id,
      publicId: order.publicId,
      status: order.status,
      total: order.total,
      items: order.items,
      shop: { id: shop.id, name: shop.name, kind: shop.kind },
    });
  } catch (err: any) {
    logger.error({ err }, '[Yard] POST /yard/orders упал');
    res.status(500).json({ error: 'Не удалось создать заказ', details: String(err?.message ?? err) });
  }
});

function toBuyerOrderDto(order: any) {
  const phoneVisible = YARD_PHONE_VISIBLE_STATUSES.includes(order.status);
  return {
    id: order.id,
    publicId: order.publicId,
    status: order.status,
    total: order.total,
    createdAt: order.createdAt,
    items: order.items,
    shop: {
      id: order.shop.id,
      name: order.shop.name,
      kind: order.shop.kind,
      phone: phoneVisible ? order.shop.phone : null,
    },
  };
}

/** Заказы покупателя — только его собственные, по телефону. Чужой номер чужой полки не видит. */
yardRouter.get('/yard/orders', async (req, res) => {
  const normalizedPhone = normalizePhone(String(req.query.phone ?? ''));
  if (!normalizedPhone) return res.status(400).json({ error: 'Некорректный номер телефона' });

  try {
    const orders = await prisma.yardOrder.findMany({
      where: { buyerPhone: normalizedPhone },
      include: { items: true, shop: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders.map(toBuyerOrderDto));
  } catch (err: any) {
    logger.error({ err }, '[Yard] GET /yard/orders упал');
    res.status(500).json({ error: 'Не удалось получить заказы', details: String(err?.message ?? err) });
  }
});

/** Определяет, какая сторона заказа шлёт сообщение — покупатель или магазин. */
async function resolveYardParty(orderId: string, phone: string): Promise<'buyer' | 'shop' | null> {
  const order = await prisma.yardOrder.findUnique({ where: { id: orderId }, include: { shop: true } });
  if (!order) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  if (normalized === order.buyerPhone) return 'buyer';
  if (normalized === order.shop.phone) return 'shop';
  return null;
}

const receiptSchema = z.object({ phone: z.string().min(1), imageUrl: z.string().url() });

/** Скрин чека в чат заказа — от любой из двух сторон, чужой номер отклоняем. */
yardRouter.post('/yard/orders/:id/receipt', async (req, res) => {
  const parsed = receiptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const from = await resolveYardParty(req.params.id, parsed.data.phone);
    if (!from) return res.status(403).json({ error: 'Этот номер не участвует в заказе' });
    const message = await prisma.yardMessage.create({
      data: { orderId: req.params.id, from, imageUrl: parsed.data.imageUrl },
    });
    res.status(201).json(message);
  } catch (err: any) {
    logger.error({ err }, '[Yard] POST /yard/orders/:id/receipt упал');
    res.status(500).json({ error: 'Не удалось отправить скрин чека', details: String(err?.message ?? err) });
  }
});

const messageSchema = z.object({ phone: z.string().min(1), text: z.string().min(1).max(1000) });

/** Сообщение в чат заказа — чат только внутри заказа, не публично. */
yardRouter.post('/yard/orders/:id/message', async (req, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const from = await resolveYardParty(req.params.id, parsed.data.phone);
    if (!from) return res.status(403).json({ error: 'Этот номер не участвует в заказе' });
    const message = await prisma.yardMessage.create({
      data: { orderId: req.params.id, from, text: parsed.data.text },
    });
    res.status(201).json(message);
  } catch (err: any) {
    logger.error({ err }, '[Yard] POST /yard/orders/:id/message упал');
    res.status(500).json({ error: 'Не удалось отправить сообщение', details: String(err?.message ?? err) });
  }
});

/**
 * Кабинет «Я магазин» — по телефону. Нет такого магазина ещё — не ошибка,
 * просто shop:null. Заказы отдаём с телефоном покупателя ТОЛЬКО с accepted
 * и дальше — то же правило, что у покупателя, симметрично.
 */
yardRouter.get('/yard/mine', async (req, res) => {
  const normalizedPhone = normalizePhone(String(req.query.phone ?? ''));
  if (!normalizedPhone) return res.status(400).json({ error: 'Некорректный номер телефона' });

  try {
    const shop = await prisma.yardShop.findUnique({ where: { phone: normalizedPhone } });
    if (!shop) return res.json({ shop: null, items: [], orders: [] });

    const [items, orders] = await Promise.all([
      prisma.yardItem.findMany({ where: { shopId: shop.id }, orderBy: { id: 'asc' } }),
      prisma.yardOrder.findMany({ where: { shopId: shop.id }, include: { items: true }, orderBy: { createdAt: 'desc' } }),
    ]);

    res.json({
      shop,
      items,
      orders: orders.map((o: any) => ({
        id: o.id,
        publicId: o.publicId,
        status: o.status,
        total: o.total,
        createdAt: o.createdAt,
        items: o.items,
        buyerName: o.buyerName,
        buyerPhone: YARD_PHONE_VISIBLE_STATUSES.includes(o.status) ? o.buyerPhone : null,
        address: YARD_PHONE_VISIBLE_STATUSES.includes(o.status) ? o.address : null,
      })),
    });
  } catch (err: any) {
    logger.error({ err }, '[Yard] GET /yard/mine упал');
    res.status(500).json({ error: 'Не удалось получить кабинет', details: String(err?.message ?? err) });
  }
});

const mineSchema = z.object({
  phone: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['home', 'grocery', 'bakery', 'hozyayushka']),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

/** Создание/правка профиля своего двора — одна запись на телефон (upsert). */
yardRouter.post('/yard/mine', async (req, res) => {
  const parsed = mineSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  const normalizedPhone = normalizePhone(parsed.data.phone);
  if (!normalizedPhone) return res.status(400).json({ error: 'Некорректный номер телефона' });

  try {
    const data = {
      name: parsed.data.name,
      kind: parsed.data.kind,
      address: parsed.data.address,
      ...(parsed.data.lat !== undefined ? { lat: parsed.data.lat } : {}),
      ...(parsed.data.lng !== undefined ? { lng: parsed.data.lng } : {}),
    };
    const shop = await prisma.yardShop.upsert({
      where: { phone: normalizedPhone },
      update: data,
      create: { phone: normalizedPhone, ...data },
    });
    res.json(shop);
  } catch (err: any) {
    logger.error({ err }, '[Yard] POST /yard/mine упал');
    res.status(500).json({ error: 'Не удалось сохранить магазин', details: String(err?.message ?? err) });
  }
});

const mineItemSchema = z.object({
  phone: z.string().min(1),
  id: z.string().optional(),
  name: z.string().min(1),
  price: z.number().nonnegative(),
  stock: z.number().int().nonnegative(),
  photo: z.string().url().optional().nullable(),
  active: z.boolean().optional().default(true),
});

/** Добавить/поправить одну позицию полки — только владелец (по телефону). */
yardRouter.post('/yard/mine/items', async (req, res) => {
  const parsed = mineItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  const normalizedPhone = normalizePhone(parsed.data.phone);
  if (!normalizedPhone) return res.status(400).json({ error: 'Некорректный номер телефона' });

  try {
    const shop = await prisma.yardShop.findUnique({ where: { phone: normalizedPhone } });
    if (!shop) return res.status(404).json({ error: 'Сначала создайте свой двор (POST /yard/mine)' });

    const itemData = {
      name: parsed.data.name,
      price: parsed.data.price,
      stock: parsed.data.stock,
      photo: parsed.data.photo ?? null,
      active: parsed.data.active,
    };

    if (parsed.data.id) {
      const existing = await prisma.yardItem.findUnique({ where: { id: parsed.data.id } });
      if (!existing || existing.shopId !== shop.id) return res.status(404).json({ error: 'Товар не найден на вашей полке' });
      const updated = await prisma.yardItem.update({ where: { id: parsed.data.id }, data: itemData });
      return res.json(updated);
    }
    const created = await prisma.yardItem.create({ data: { ...itemData, shopId: shop.id } });
    res.status(201).json(created);
  } catch (err: any) {
    logger.error({ err }, '[Yard] POST /yard/mine/items упал');
    res.status(500).json({ error: 'Не удалось сохранить товар', details: String(err?.message ?? err) });
  }
});

const paymentSchema = z.object({ phone: z.string().min(1), ok: z.boolean() });

async function requireYardShopOwner(
  orderId: string,
  phone: string,
): Promise<{ error: string; status: number } | { order: any }> {
  const order = await prisma.yardOrder.findUnique({ where: { id: orderId }, include: { shop: true } });
  if (!order) return { error: 'Заказ не найден', status: 404 };
  const normalized = normalizePhone(phone);
  if (!normalized || normalized !== order.shop.phone) {
    return { error: 'Только продавец может выполнить это действие', status: 403 };
  }
  return { order };
}

/** «Оплата есть/нет» — только продавец своего заказа. Полка списывается ТОЛЬКО по «Оплата есть». */
yardRouter.post('/yard/orders/:id/payment', async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const check = await requireYardShopOwner(req.params.id, parsed.data.phone);
    if ('error' in check) return res.status(check.status).json({ error: check.error });
    const order = await yardApplyPayment(req.params.id, parsed.data.ok);
    res.json(order);
  } catch (err: any) {
    if (err instanceof YardTransitionError) return res.status(err.status).json({ error: err.message });
    logger.error({ err }, '[Yard] POST /yard/orders/:id/payment упал');
    res.status(500).json({ error: 'Не удалось отметить оплату', details: String(err?.message ?? err) });
  }
});

const phoneOnlySchema = z.object({ phone: z.string().min(1) });

/** «Принял» — только продавец, только из paid. Дальше телефон покупателя виден. */
yardRouter.post('/yard/orders/:id/accept', async (req, res) => {
  const parsed = phoneOnlySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const check = await requireYardShopOwner(req.params.id, parsed.data.phone);
    if ('error' in check) return res.status(check.status).json({ error: check.error });
    const order = await yardApplyAccept(req.params.id);
    res.json(order);
  } catch (err: any) {
    if (err instanceof YardTransitionError) return res.status(err.status).json({ error: err.message });
    logger.error({ err }, '[Yard] POST /yard/orders/:id/accept упал');
    res.status(500).json({ error: 'Не удалось принять заказ', details: String(err?.message ?? err) });
  }
});

const closeSchema = z.object({ phone: z.string().min(1), status: z.enum(['done', 'not_picked', 'out_of_stock']) });

/** Закрытие — done | not_picked | out_of_stock. Последние два возвращают остаток на полку. */
yardRouter.post('/yard/orders/:id/close', async (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const check = await requireYardShopOwner(req.params.id, parsed.data.phone);
    if ('error' in check) return res.status(check.status).json({ error: check.error });
    const order = await yardApplyClose(req.params.id, parsed.data.status);
    res.json(order);
  } catch (err: any) {
    if (err instanceof YardTransitionError) return res.status(err.status).json({ error: err.message });
    logger.error({ err }, '[Yard] POST /yard/orders/:id/close упал');
    res.status(500).json({ error: 'Не удалось закрыть заказ', details: String(err?.message ?? err) });
  }
});
