import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { generateWaybillPdf, WaybillAddressError, WaybillOrderItem } from '../services/waybill.service';

export const shopRouter = Router();

/**
 * Все /api/shop/* маршруты защищены заголовком x-app-key — сравниваем с
 * SHOP_APP_KEY из переменных окружения. Если ключ не настроен на сервере —
 * честно отказываем всем запросам (не открываем API "по умолчанию").
 */
shopRouter.use((req, res, next) => {
  if (!env.shopAppKey) {
    return res.status(503).json({ error: 'SHOP_APP_KEY не настроен на сервере — API My Market недоступен' });
  }
  const key = req.header('x-app-key');
  if (key !== env.shopAppKey) {
    return res.status(401).json({ error: 'Неверный или отсутствующий заголовок x-app-key' });
  }
  next();
});

/** Товар как его видит приложение — ТОЛЬКО поля витрины, цена = shopPrice. */
function toShopProduct(p: any) {
  let images: string[] = [];
  try {
    images = p.images ? JSON.parse(p.images) : [];
  } catch {
    images = [];
  }
  return {
    sku: p.sku,
    name: p.name,
    category: p.category,
    subcategory: p.subcategory,
    type: p.type,
    price: p.shopPrice,
    oldPrice: p.shopOldPrice,
    stock: p.shopStock,
    description: p.description,
    composition: p.composition,
    images,
    video: p.shopVideo ?? null,
    delivery: p.shopDelivery,
    banner: p.banner,
    bannerTitle: p.bannerTitle,
    bannerSubtitle: p.bannerSubtitle,
  };
}

shopRouter.get('/products', async (_req, res) => {
  try {
    const products = await prisma.product.findMany({ where: { shopActive: true } });
    res.json(products.map(toShopProduct));
  } catch (err: any) {
    logger.error({ err }, '[Shop API] GET /products упал');
    res.status(500).json({ error: 'Не удалось получить товары', details: String(err?.message ?? err) });
  }
});

shopRouter.get('/products/:sku', async (req, res) => {
  try {
    const product = await prisma.product.findFirst({ where: { sku: req.params.sku, shopActive: true } });
    if (!product) return res.status(404).json({ error: 'Товар не найден' });
    res.json(toShopProduct(product));
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось получить товар', details: String(err?.message ?? err) });
  }
});

/**
 * Категории — ТОЛЬКО из явно проставленных полей category/subcategory/type
 * (форма редактирования или загрузка Excel в разделе «My Market»). Никакого
 * автоматического угадывания категории по названию — если поле пустое,
 * товар просто не попадёт ни в одну категорию.
 */
shopRouter.get('/categories', async (_req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { shopActive: true, category: { not: null } },
      select: { category: true, subcategory: true, type: true },
    });
    const tree = new Map<string, Map<string, Set<string>>>();
    for (const p of products) {
      if (!p.category) continue;
      if (!tree.has(p.category)) tree.set(p.category, new Map());
      const subMap = tree.get(p.category)!;
      const subKey = p.subcategory ?? '';
      if (!subMap.has(subKey)) subMap.set(subKey, new Set());
      if (p.type) subMap.get(subKey)!.add(p.type);
    }
    const result = Array.from(tree.entries()).map(([category, subMap]) => ({
      category,
      subcategories: Array.from(subMap.entries())
        .filter(([sub]) => sub !== '')
        .map(([subcategory, types]) => ({ subcategory, types: Array.from(types) })),
    }));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось получить категории', details: String(err?.message ?? err) });
  }
});

shopRouter.get('/banners', async (_req, res) => {
  try {
    // Слайды карусели — отдельная сущность ShopBanner (не поле товара),
    // т.к. баннер может вести и на конкретный товар, и на категорию.
    // Отдаём только включённые (active=true) и хотя бы с картинкой —
    // пустой "выключенный" слот приложению не нужен.
    const banners = await prisma.shopBanner.findMany({
      where: { active: true, imageUrl: { not: null } },
      orderBy: { slot: 'asc' },
    });
    res.json(banners.map((b) => ({
      imageUrl: b.imageUrl,
      title: b.title,
      subtitle: b.subtitle,
      linkType: b.linkType,
      linkValue: b.linkValue,
    })));
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось получить баннеры', details: String(err?.message ?? err) });
  }
});

shopRouter.get('/products/:sku/reviews', async (req, res) => {
  try {
    const reviews = await prisma.shopReview.findMany({ where: { sku: req.params.sku }, orderBy: { date: 'desc' } });
    res.json(reviews);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось получить отзывы', details: String(err?.message ?? err) });
  }
});

const orderItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  price: z.number().nonnegative(),
  quantity: z.number().int().positive(),
});

const createOrderSchema = z.object({
  city: z.string().min(1),
  street: z.string().min(1),
  house: z.string().min(1),
  apartment: z.string().optional().nullable(),
  entrance: z.string().optional().nullable(),
  floor: z.string().optional().nullable(),
  intercom: z.string().optional().nullable(),
  comment: z.string().optional().nullable(),
  customerName: z.string().min(1),
  phone: z.string().min(1),
  items: z.array(orderItemSchema).min(1),
});

function generateOrderNumber(): string {
  const d = new Date();
  // Формат MM-ГГММДД-XXXX (2 цифры года, не 4).
  const yy = String(d.getFullYear()).slice(-2);
  const datePart = `${yy}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const randPart = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `MM-${datePart}-${randPart}`;
}

function generatePickupCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 цифры, 1000–9999
}

shopRouter.post('/orders', async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные заказа', details: parsed.error.flatten() });

  try {
    const total = parsed.data.items.reduce((sum, i) => sum + i.price * i.quantity, 0);

    // Гарантируем уникальность номера — крайне маловероятная коллизия, но
    // проверяем, а не полагаемся вслепую на рандом.
    let number = generateOrderNumber();
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await prisma.shopOrder.findUnique({ where: { number } });
      if (!exists) break;
      number = generateOrderNumber();
    }

    const order = await prisma.shopOrder.create({
      data: {
        number,
        pickupCode: generatePickupCode(),
        status: 'pending_payment',
        city: parsed.data.city,
        street: parsed.data.street,
        house: parsed.data.house,
        apartment: parsed.data.apartment || null,
        entrance: parsed.data.entrance || null,
        floor: parsed.data.floor || null,
        intercom: parsed.data.intercom || null,
        comment: parsed.data.comment || null,
        customerName: parsed.data.customerName,
        phone: parsed.data.phone,
        total,
        items: JSON.stringify(parsed.data.items),
      },
    });

    res.status(201).json({ id: order.id, number: order.number, pickupCode: order.pickupCode, total: order.total, status: order.status });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка создания заказа');
    res.status(500).json({ error: 'Не удалось создать заказ', details: String(err?.message ?? err) });
  }
});

/**
 * Подтверждение оплаты — сейчас вызывается продавцом вручную после того,
 * как проверил QR/перевод (веб-хук платёжной системы можно подключить сюда
 * же позже, эндпоинт для этого уже есть). При оплате:
 *  1) статус ShopOrder -> paid, списывается остаток (shopStock).
 *  2) создаётся Order+OrderItem с marketplace=APP — чтобы заказ сразу
 *     попал в общую юнит-экономику (Обзор/Финансы/Товары), без отдельного
 *     параллельного пути отчётности.
 */
shopRouter.post('/orders/:id/paid', async (req, res) => {
  try {
    const shopOrder = await prisma.shopOrder.findUnique({ where: { id: req.params.id } });
    if (!shopOrder) return res.status(404).json({ error: 'Заказ не найден' });
    if (shopOrder.status !== 'pending_payment') {
      return res.status(409).json({ error: `Заказ уже в статусе "${shopOrder.status}" — повторно оплатить нельзя` });
    }

    const items: Array<{ sku: string; name: string; price: number; quantity: number }> = JSON.parse(shopOrder.items);

    // Списываем остаток по каждой позиции — не даём уйти в минус.
    for (const item of items) {
      const product = await prisma.product.findUnique({ where: { sku: item.sku } });
      if (product) {
        await prisma.product.update({
          where: { id: product.id },
          data: { shopStock: Math.max(0, product.shopStock - item.quantity) },
        });
      }
    }

    // Логистика заказа (если проставлена вручную в админке) распределяется
    // между позициями пропорционально их доле в выручке заказа — тот же
    // принцип, что уже используется для распределения расходов на рекламу.
    const orderRevenue = items.reduce((sum, i) => sum + i.price * i.quantity, 0) || 1;

    const orderItemsData = await Promise.all(items.map(async (item) => {
      const product = await prisma.product.findUnique({ where: { sku: item.sku } });
      const itemRevenue = item.price * item.quantity;
      const itemLogistics = (itemRevenue / orderRevenue) * shopOrder.logisticsCost;
      return {
        productId: product?.id ?? null,
        externalSku: item.sku,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        // Себестоимость для канала APP — приоритетно shopCost (своя цена
        // закупа для витрины), иначе общая costPrice, иначе 0.
        costPrice: product?.shopCost ?? product?.costPrice ?? 0,
        commission: 0, // канал APP — своя витрина, комиссии площадки нет
        itemLogistics: Math.round(itemLogistics * 100) / 100,
      };
    }));

    await prisma.$transaction([
      prisma.shopOrder.update({ where: { id: shopOrder.id }, data: { status: 'paid', paidAt: new Date() } }),
      prisma.order.create({
        data: {
          marketplace: 'APP',
          externalId: shopOrder.number,
          status: 'paid',
          orderDate: new Date(),
          totalRevenue: shopOrder.total,
          marketplaceCommission: 0,
          logisticsCost: shopOrder.logisticsCost,
          items: { create: orderItemsData },
        },
      }),
    ]);

    res.json({ ok: true, status: 'paid' });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка подтверждения оплаты');
    res.status(500).json({ error: 'Не удалось подтвердить оплату', details: String(err?.message ?? err) });
  }
});

/** Сравнение телефонов только по цифрам (последние 10) — терпимо к
 *  разным форматам записи (+7 xxx, 8xxx, пробелы/дефисы и т.п.). */
function phonesMatch(a: string, b: string): boolean {
  const digitsA = a.replace(/\D/g, '').slice(-10);
  const digitsB = b.replace(/\D/g, '').slice(-10);
  return digitsA.length === 10 && digitsA === digitsB;
}

/**
 * Отмена заказа покупателем — разрешена ТОЛЬКО из pending_payment (ещё не
 * оплачен) или paid (оплачен, но ещё не собран/выдан). Из любого другого
 * статуса (assembled/delivered/cancelled) — 409, уже нельзя отменить.
 *
 * Если заказ был paid — остаток shopStock уже был списан в момент оплаты
 * (см. /orders/:id/paid), значит здесь его нужно вернуть обратно. Заодно
 * убираем связанный Order/OrderItem (созданный на этапе paid для общей
 * юнит-экономики) — иначе выручка и себестоимость отменённого заказа
 * продолжили бы засчитываться в «Финансы»/«Обзор» (общий запрос отчётов
 * не фильтрует заказы по статусу — специально не трогаю эту логику,
 * она общая с Kaspi/Ozon/WB). Order→OrderItem удаляется каскадно.
 */
shopRouter.post('/orders/:id/cancel', async (req, res) => {
  try {
    const order = await prisma.shopOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });

    const phone = String(req.body?.phone ?? '');
    if (!phone || !phonesMatch(phone, order.phone)) {
      return res.status(403).json({ error: 'Номер телефона не совпадает с заказом' });
    }

    if (order.status !== 'pending_payment' && order.status !== 'paid') {
      return res.status(409).json({ error: 'уже нельзя отменить' });
    }

    if (order.status === 'paid') {
      const items: Array<{ sku: string; quantity: number }> = JSON.parse(order.items);
      for (const item of items) {
        const product = await prisma.product.findUnique({ where: { sku: item.sku } });
        if (product) {
          await prisma.product.update({
            where: { id: product.id },
            data: { shopStock: product.shopStock + item.quantity },
          });
        }
      }
      await prisma.order.deleteMany({ where: { marketplace: 'APP', externalId: order.number } });
    }

    await prisma.shopOrder.update({ where: { id: order.id }, data: { status: 'cancelled' } });
    res.json({ ok: true, status: 'cancelled' });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка отмены заказа');
    res.status(500).json({ error: 'Не удалось отменить заказ', details: String(err?.message ?? err) });
  }
});

/**
 * Заказ "как есть" для приложения — только СВОЙ заказ: номер телефона в
 * query должен совпадать с телефоном в заказе (простая, но реальная
 * проверка "это точно тот же покупатель", без отдельной системы токенов).
 * Код выдачи (4 цифры) здесь ЕСТЬ — приложение показывает его в "Мои
 * заказы", это НЕ то же самое, что накладная (там код печатать нельзя).
 */
shopRouter.get('/orders/:id', async (req, res) => {
  try {
    const order = await prisma.shopOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    const phone = String(req.query.phone ?? '');
    if (!phone || !phonesMatch(phone, order.phone)) {
      return res.status(403).json({ error: 'Номер телефона не совпадает с заказом' });
    }
    res.json({
      number: order.number,
      status: order.status,
      pickupCode: order.pickupCode,
      total: order.total,
      items: JSON.parse(order.items),
      createdAt: order.createdAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось получить заказ', details: String(err?.message ?? err) });
  }
});

/**
 * Та же накладная, что и в админке (см. shopMedia.routes.ts), но с
 * авторизацией под конкретного покупателя — x-app-key (уже проверен общим
 * middleware выше) ПЛЮС номер телефона должен совпадать с заказом.
 */
shopRouter.get('/orders/:id/waybill', async (req, res) => {
  try {
    const order = await prisma.shopOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    const phone = String(req.query.phone ?? '');
    if (!phone || !phonesMatch(phone, order.phone)) {
      return res.status(403).json({ error: 'Номер телефона не совпадает с заказом' });
    }

    let items: WaybillOrderItem[] = [];
    try {
      items = (JSON.parse(order.items) as Array<{ sku: string; name: string; quantity: number }>)
        .map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity }));
    } catch {
      items = [];
    }

    const pdfBuffer = await generateWaybillPdf({
      number: order.number,
      customerName: order.customerName,
      phone: order.phone,
      city: order.city,
      street: order.street,
      house: order.house,
      apartment: order.apartment,
      entrance: order.entrance,
      floor: order.floor,
      intercom: order.intercom,
      items,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="waybill-${order.number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err: any) {
    if (err instanceof WaybillAddressError) {
      return res.status(400).json({ error: 'не заполнен адрес' });
    }
    logger.error({ err }, '[Shop API] Ошибка генерации накладной (клиент)');
    res.status(500).json({ error: 'Не удалось сформировать накладную', details: String(err?.message ?? err) });
  }
});
