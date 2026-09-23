import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { put } from '@vercel/blob';
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

    // Код выдачи здесь НЕ создаётся — только по запросу курьера
    // (/api/shop/courier/request-code), непосредственно перед выдачей.
    const order = await prisma.shopOrder.create({
      data: {
        number,
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

    res.status(201).json({ id: order.id, number: order.number, total: order.total, status: order.status });
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
/**
 * Общая логика перехода ShopOrder в paid — списание остатка + создание
 * Order/OrderItem для юнит-экономики. Используется и клиентским
 * /orders/:id/paid (пока — ручное подтверждение продавцом, в будущем —
 * вебхук эквайринга), и админской кнопкой «Отметить оплаченным» — ОДИН
 * код на оба пути, поэтому повторное списание физически невозможно: и там,
 * и там первым делом проверяется, что заказ ещё pending_payment.
 */
export async function markShopOrderAsPaid(orderId: string): Promise<
  { ok: true } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'wrong_status'; status: string }
> {
  const shopOrder = await prisma.shopOrder.findUnique({ where: { id: orderId } });
  if (!shopOrder) return { ok: false, reason: 'not_found' };
  if (shopOrder.status !== 'pending_payment') {
    return { ok: false, reason: 'wrong_status', status: shopOrder.status };
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

  return { ok: true };
}

shopRouter.post('/orders/:id/paid', async (req, res) => {
  try {
    const result = await markShopOrderAsPaid(req.params.id);
    if (!result.ok) {
      if (result.reason === 'not_found') return res.status(404).json({ error: 'Заказ не найден' });
      return res.status(409).json({ error: `Заказ уже в статусе "${result.status}" — повторно оплатить нельзя` });
    }
    res.json({ ok: true, status: 'paid' });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка подтверждения оплаты');
    res.status(500).json({ error: 'Не удалось подтвердить оплату', details: String(err?.message ?? err) });
  }
});

/** Сравнение телефонов только по цифрам (последние 10) — терпимо к
 *  разным форматам записи (+7 xxx, 8xxx, пробелы/дефисы и т.п.). */
/**
 * Нормализация номера телефона к канонической форме "7XXXXXXXXXX" (11 цифр,
 * без +/пробелов/скобок/дефисов). 8XXXXXXXXXX, 7XXXXXXXXXX и +7XXXXXXXXXX —
 * один и тот же номер, приводятся к одному виду. Возвращает null, если
 * после нормализации не получился похожий на телефон номер (не 10-11 цифр).
 */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '8') return '7' + digits.slice(1);
  if (digits.length === 11 && digits[0] === '7') return digits;
  if (digits.length === 10) return '7' + digits; // без кода страны — считаем, что это +7
  return null;
}

/** Сравнение телефонов ТОЛЬКО после нормализации — сырые строки никогда
 *  не сравниваются напрямую (разный формат записи — это один и тот же
 *  номер, если совпадает после normalizePhone). */
function phonesMatch(a: string, b: string): boolean {
  const normA = normalizePhone(a);
  const normB = normalizePhone(b);
  return normA !== null && normA === normB;
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

// =====================================================================
// Курьер My Market — работает ТОЛЬКО через этот API (x-app-key, тот же,
// что у покупателя). Никакого отдельного логина в саму админку unit-v4
// для курьера нет и не предусмотрено.
//
// Новая цепочка статусов заказа:
//   pending_payment → paid → picked (курьер забрал) → in_transit (в пути)
//   → delivered (выдан), и параллельно pending_payment/paid → cancelled.
// "assembled" из старой версии здесь больше не используется — вместо
// одного промежуточного статуса теперь два, привязанных к реальным
// действиям курьера (scan/start), а не к абстрактной "сборке".
// =====================================================================

const CODE_MAX_ATTEMPTS = 5;
const DEFAULT_COURIER_PAYOUT = 2000;

function generatePickupCode5(): string {
  return String(Math.floor(10000 + Math.random() * 90000)); // 5 цифр, 10000–99999
}

/**
 * Номер заказа со стикера может прийти как есть ("MM-260922-0282") или
 * без разделителей, как его иногда отдают сканеры штрихкодов
 * ("MM2609220282") — приводим ко второй форме к канонической с дефисами,
 * чтобы искать по уникальному полю number как обычно.
 */
/**
 * Номер заказа со стикера может прийти как есть ("MM-260922-0282") или
 * без разделителей, как его иногда отдают сканеры штрихкодов
 * ("MM2609220282"). Плюс — заказы, созданные ДО перехода на 2-значный год
 * в номере, хранятся в старом формате ("MM-20260922-0282", 8 цифр даты
 * вместо 6) — если проверять только новый формат, такие старые заказы
 * никогда не найдутся, хотя реально существуют. Возвращает ВСЕ разумные
 * варианты канонического номера — вызывающий код пробует их по очереди.
 */
function buildOrderNumberCandidates(raw: string): string[] {
  const clean = raw.trim().toUpperCase();
  const candidates = new Set<string>();

  if (/^MM-\d{6}-\d{4}$/.test(clean) || /^MM-\d{8}-\d{4}$/.test(clean)) {
    candidates.add(clean);
  }

  const stripped = clean.replace(/[^A-Z0-9]/g, '');
  const shortMatch = stripped.match(/^MM(\d{6})(\d{4})$/); // новый формат: MM + YYMMDD + XXXX
  if (shortMatch) candidates.add(`MM-${shortMatch[1]}-${shortMatch[2]}`);
  const longMatch = stripped.match(/^MM(\d{8})(\d{4})$/); // старый формат: MM + YYYYMMDD + XXXX
  if (longMatch) candidates.add(`MM-${longMatch[1]}-${longMatch[2]}`);

  if (candidates.size === 0) candidates.add(clean); // не удалось распознать — пробуем как есть

  return Array.from(candidates);
}

/** Ищет ShopOrder по номеру, перебирая все разумные варианты формата
 *  (см. buildOrderNumberCandidates) — не только "как ввели буквально". */
async function findShopOrderByNumberLoosely(raw: string) {
  for (const candidate of buildOrderNumberCandidates(raw)) {
    const order = await prisma.shopOrder.findUnique({ where: { number: candidate } });
    if (order) return order;
  }
  return null;
}

const courierRegisterSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(1),
  requisitesType: z.enum(['kaspi', 'card']),
  requisitesValue: z.string().min(1),
  iin: z.string().min(1),
  address: z.string().min(1),
  vehicle: z.string().min(1),
  // Без этих двух URL — регистрация не пройдёт (400). Их получают ЗАРАНЕЕ
  // через POST /courier/upload-photo, здесь только принимаем готовые ссылки.
  idPhotoUrl: z.string().min(1),
  facePhotoUrl: z.string().min(1),
});

/**
 * Регистрация курьера — имя, фамилия, телефон, реквизиты для выплат
 * (Kaspi-перевод по номеру телефона или номер карты), ИИН, адрес, авто,
 * фото удостоверения и лица (оба обязательны — без них 400 через zod).
 * Повторная регистрация с уже известным телефоном обновляет данные
 * (upsert), а не создаёт дубликат. Дата согласия (agreeContractAt)
 * проставляется автоматически моментом регистрации — считаем, что
 * заполнение формы регистрации и есть момент согласия с офертой.
 */
shopRouter.post('/courier/register', async (req, res) => {
  const parsed = courierRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные регистрации', details: parsed.error.flatten() });

  const normalizedPhone = normalizePhone(parsed.data.phone);
  if (!normalizedPhone) return res.status(400).json({ error: 'Некорректный номер телефона' });

  try {
    const name = `${parsed.data.firstName} ${parsed.data.lastName}`.trim();
    const commonData = {
      name,
      requisitesType: parsed.data.requisitesType,
      requisitesValue: parsed.data.requisitesValue,
      iin: parsed.data.iin,
      address: parsed.data.address,
      vehicle: parsed.data.vehicle,
      idPhotoUrl: parsed.data.idPhotoUrl,
      facePhotoUrl: parsed.data.facePhotoUrl,
    };
    const courier = await prisma.courier.upsert({
      where: { phone: normalizedPhone },
      update: commonData, // agreeContractAt НЕ трогаем при повторной регистрации — дата согласия должна быть первой, не последней
      create: { ...commonData, phone: normalizedPhone, agreeContractAt: new Date() },
    });
    res.status(201).json({ id: courier.id, name: courier.name, phone: courier.phone });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка регистрации курьера');
    res.status(500).json({ error: 'Не удалось зарегистрировать курьера', details: String(err?.message ?? err) });
  }
});

const COURIER_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const COURIER_PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5 МБ
const courierPhotoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: COURIER_PHOTO_MAX_BYTES } });

/**
 * Загрузка фото курьера (удостоверение или лицо) — multipart/form-data,
 * поле файла "file", поле "type" = "id" | "face". Сохраняется туда же,
 * куда фото товаров (Vercel Blob) — тот же токен, тот же принцип. Без
 * настроенного Blob — честный 501 "добавьте Blob", как и для фото товаров.
 */
shopRouter.post('/courier/upload-photo', courierPhotoUpload.single('file'), async (req, res) => {
  const type = req.body?.type;
  if (type !== 'id' && type !== 'face') {
    return res.status(400).json({ error: 'Поле type должно быть "id" или "face"' });
  }
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: 'Файл не передан (поле "file")' });

  if (!env.blobToken) {
    return res.status(501).json({ error: 'добавьте Blob', details: 'BLOB_READ_WRITE_TOKEN не задан в переменных окружения — загрузка фото недоступна.' });
  }
  if (!COURIER_PHOTO_TYPES.includes(file.mimetype)) {
    return res.status(400).json({ error: `Недопустимый формат файла: ${file.mimetype}. Разрешено: ${COURIER_PHOTO_TYPES.join(', ')}` });
  }

  try {
    const pathname = `courier/${type}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const blob = await put(pathname, file.buffer, { access: 'public', contentType: file.mimetype, token: env.blobToken });
    res.json({ url: blob.url });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка загрузки фото курьера');
    res.status(500).json({ error: 'Не удалось загрузить фото', details: String(err?.message ?? err) });
  }
});

/** Ищет активного курьера по телефону — общая часть для всех эндпоинтов
 *  ниже, отдаёт понятную ошибку, если курьера нет или он заблокирован.
 *  Возвращает полную запись (включая поля верификации) — так вызывающий
 *  код может проверить полноту профиля (см. isCourierProfileComplete). */
async function findActiveCourierOrFail(rawPhone: string, res: any): Promise<{
  id: string; phone: string; idPhotoUrl: string | null; facePhotoUrl: string | null; iin: string | null; agreeContractAt: Date | null;
} | null> {
  const normalizedPhone = normalizePhone(rawPhone);
  if (!normalizedPhone) {
    res.status(400).json({ error: 'Некорректный номер телефона курьера' });
    return null;
  }
  const courier = await prisma.courier.findUnique({ where: { phone: normalizedPhone } });
  if (!courier || !courier.active) {
    res.status(403).json({ error: 'Курьер не зарегистрирован или заблокирован' });
    return null;
  }
  return courier;
}

/** Профиль курьера считается заполненным, только если есть оба фото, ИИН
 *  и дата согласия — проверяется перед scan (см. п.5 запроса). */
function isCourierProfileComplete(courier: { idPhotoUrl: string | null; facePhotoUrl: string | null; iin: string | null; agreeContractAt: Date | null }): boolean {
  return !!(courier.idPhotoUrl && courier.facePhotoUrl && courier.iin && courier.agreeContractAt);
}

const courierScanSchema = z.object({
  courierPhone: z.string().min(1),
  barcode: z.string().min(1),
});

/**
 * Курьер сканирует стикер на складе — заказ переходит paid → picked и
 * закрепляется за этим курьером. Разрешено только для paid (ещё никем не
 * забран) и только не для собственного заказа курьера (антифрод: курьер
 * не может "забрать" покупку, оформленную на свой же телефон).
 */
shopRouter.post('/courier/scan', async (req, res) => {
  const parsed = courierScanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });

  try {
    const courier = await findActiveCourierOrFail(parsed.data.courierPhone, res);
    if (!courier) return;
    if (!isCourierProfileComplete(courier)) {
      return res.status(403).json({ error: 'Профиль курьера не заполнен полностью — нужны оба фото, ИИН и согласие с договором' });
    }

    const order = await findShopOrderByNumberLoosely(parsed.data.barcode);
    if (!order) {
      // Логируем ВСЁ, что пробовали — если это повторится, в логах будет
      // видно точную причину (опечатка, лишний символ, реально другой
      // номер), а не только результат "не нашли".
      logger.warn(
        { rawBarcode: parsed.data.barcode, triedCandidates: buildOrderNumberCandidates(parsed.data.barcode) },
        '[Shop API] /courier/scan: заказ не найден ни по одному варианту номера',
      );
      return res.status(404).json({ error: 'Заказ не найден' });
    }

    if (order.status === 'pending_payment') {
      return res.status(409).json({ error: 'Заказ не оплачен' });
    }
    if (order.status !== 'paid') {
      return res.status(409).json({ error: `Заказ в статусе "${order.status}" — забрать можно только оплаченный заказ` });
    }
    if (phonesMatch(courier.phone, order.phone)) {
      return res.status(403).json({ error: 'Нельзя забрать собственный заказ' });
    }

    await prisma.shopOrder.update({ where: { id: order.id }, data: { status: 'picked', courierId: courier.id } });
    res.json({ ok: true, status: 'picked', orderNumber: order.number });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка сканирования заказа курьером');
    res.status(500).json({ error: 'Не удалось забрать заказ', details: String(err?.message ?? err) });
  }
});

const courierOrderRefSchema = z.object({
  courierPhone: z.string().min(1),
  orderNumber: z.string().min(1),
});

/** Курьер выехал с заказом — picked → in_transit. Только для СВОЕГО заказа. */
shopRouter.post('/courier/start', async (req, res) => {
  const parsed = courierOrderRefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });

  try {
    const courier = await findActiveCourierOrFail(parsed.data.courierPhone, res);
    if (!courier) return;

    const order = await findShopOrderByNumberLoosely(parsed.data.orderNumber);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    if (order.courierId !== courier.id) return res.status(403).json({ error: 'Это не ваш заказ' });
    if (order.status !== 'picked') {
      return res.status(409).json({ error: `Заказ в статусе "${order.status}" — начать доставку можно только из "Курьер забрал"` });
    }

    await prisma.shopOrder.update({ where: { id: order.id }, data: { status: 'in_transit' } });
    res.json({ ok: true, status: 'in_transit' });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка старта доставки');
    res.status(500).json({ error: 'Не удалось начать доставку', details: String(err?.message ?? err) });
  }
});

/**
 * Курьер запрашивает код выдачи — генерируется ЗДЕСЬ, впервые (не при
 * оплате). Только для своего заказа в picked/in_transit. Код отдаётся в
 * ответе — дальше это забота приложения показать его покупателю; SMS
 * отправка — отдельная, более поздняя задача, здесь не реализована.
 */
shopRouter.post('/courier/request-code', async (req, res) => {
  const parsed = courierOrderRefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });

  try {
    const courier = await findActiveCourierOrFail(parsed.data.courierPhone, res);
    if (!courier) return;

    const order = await findShopOrderByNumberLoosely(parsed.data.orderNumber);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    if (order.courierId !== courier.id) return res.status(403).json({ error: 'Это не ваш заказ' });
    if (order.status !== 'picked' && order.status !== 'in_transit') {
      return res.status(409).json({ error: `Заказ в статусе "${order.status}" — код выдачи запросить нельзя` });
    }

    const pickupCode = generatePickupCode5();
    await prisma.shopOrder.update({ where: { id: order.id }, data: { pickupCode } });
    res.json({ ok: true, pickupCode });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка запроса кода выдачи');
    res.status(500).json({ error: 'Не удалось получить код выдачи', details: String(err?.message ?? err) });
  }
});

const courierDeliverSchema = z.object({
  courierPhone: z.string().min(1),
  orderNumber: z.string().min(1),
  code: z.string().regex(/^\d{4,5}$/, 'Код должен состоять из 4 или 5 цифр'),
});

/**
 * Подтверждение выдачи курьером.
 *  - Только СВОЙ заказ (courierId должен совпадать) — не тот же самый, что
 *    и антифрод-проверка на scan (курьер ≠ покупатель), но здесь ещё и
 *    "не чужой заказ другого курьера".
 *  - Не больше 5 неверных попыток — на 5-й ошибке блокируется КУРЬЕР
 *    целиком (Courier.active = false), не только этот заказ — дальше он
 *    не пройдёт даже findActiveCourierOrFail ни в одном из эндпоинтов.
 *  - Верный код → delivered + создаётся CourierPayout (сумма —
 *    logisticsCost заказа, если больше 0, иначе фиксированные 2000).
 */
shopRouter.post('/courier/deliver', async (req, res) => {
  const parsed = courierDeliverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });

  try {
    const courier = await findActiveCourierOrFail(parsed.data.courierPhone, res);
    if (!courier) return;

    const order = await findShopOrderByNumberLoosely(parsed.data.orderNumber);
    if (!order) return res.status(404).json({ error: 'Заказ с таким номером не найден' });

    if (order.courierId !== courier.id) return res.status(403).json({ error: 'Это не ваш заказ' });
    if (phonesMatch(courier.phone, order.phone)) return res.status(403).json({ error: 'Нельзя выдать собственный заказ' });

    if (order.status !== 'picked' && order.status !== 'in_transit') {
      return res.status(409).json({ error: `Заказ в статусе "${order.status}" — выдача недоступна` });
    }
    if (!order.pickupCode) {
      return res.status(400).json({ error: 'Код выдачи ещё не запрошен для этого заказа (см. /courier/request-code)' });
    }
    if (order.codeAttempts >= CODE_MAX_ATTEMPTS) {
      return res.status(423).json({ error: 'Курьер заблокирован из-за превышения числа неверных попыток' });
    }

    if (order.pickupCode !== parsed.data.code) {
      const attempts = order.codeAttempts + 1;
      await prisma.shopOrder.update({ where: { id: order.id }, data: { codeAttempts: attempts } });
      if (attempts >= CODE_MAX_ATTEMPTS) {
        await prisma.courier.update({ where: { id: courier.id }, data: { active: false } });
        return res.status(423).json({ error: 'Код неверный. Попытки исчерпаны — курьер заблокирован.' });
      }
      return res.status(400).json({ error: `Код неверный. Осталось попыток: ${CODE_MAX_ATTEMPTS - attempts}` });
    }

    const payoutAmount = order.logisticsCost && order.logisticsCost > 0 ? order.logisticsCost : DEFAULT_COURIER_PAYOUT;

    await prisma.$transaction([
      prisma.shopOrder.update({ where: { id: order.id }, data: { status: 'delivered', deliveredAt: new Date() } }),
      // Синхронизируем и связанный Order (для отчётности) в тот же статус.
      prisma.order.updateMany({ where: { marketplace: 'APP', externalId: order.number }, data: { status: 'delivered' } }),
      prisma.courierPayout.create({
        data: { orderId: order.id, courierId: courier.id, amount: payoutAmount, status: 'pending' },
      }),
    ]);

    res.json({ ok: true, status: 'delivered' });
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка подтверждения выдачи курьером');
    res.status(500).json({ error: 'Не удалось подтвердить выдачу', details: String(err?.message ?? err) });
  }
});

/** Список заказов курьера — для его собственного экрана "Мои заказы". */
shopRouter.get('/courier/my-orders', async (req, res) => {
  try {
    const phone = String(req.query.phone ?? '');
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return res.status(400).json({ error: 'Некорректный номер телефона' });

    const courier = await prisma.courier.findUnique({ where: { phone: normalizedPhone } });
    if (!courier) return res.status(404).json({ error: 'Курьер не найден' });

    const orders = await prisma.shopOrder.findMany({
      where: { courierId: courier.id },
      orderBy: { createdAt: 'desc' },
    });

    res.json(orders.map((o: { number: string; status: string; pickupCode: string | null; items: string }) => {
      let items: Array<{ sku: string; name: string }> = [];
      try {
        items = (JSON.parse(o.items) as Array<{ sku: string; name: string }>).map((i) => ({ sku: i.sku, name: i.name }));
      } catch {
        items = [];
      }
      return {
        number: o.number,
        status: o.status,
        items,
        canDeliver: (o.status === 'picked' || o.status === 'in_transit') && !!o.pickupCode,
      };
    }));
  } catch (err: any) {
    logger.error({ err }, '[Shop API] Ошибка получения заказов курьера');
    res.status(500).json({ error: 'Не удалось получить заказы', details: String(err?.message ?? err) });
  }
});
