import { Router } from 'express';
import { z } from 'zod';
import JSZip from 'jszip';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { markShopOrderAsPaid } from './shop.routes';
import { getSearchAnalytics, getConversionAnalytics, getSeasonalityAnalytics } from '../services/shopAnalytics.service';
import { generateWaybillPdf, WaybillOrderItem } from '../services/waybill.service';
import { maybeGenerateShopArticle } from '../services/shopArticle';
import { isValidShopCategory } from '../config/shopCategories';
import { ozonTypeKey } from '../services/sync.service';
import { hintCategoryByName, hintRuleCatalogPairs, starterCatalogPairs, buildCatalog } from '../services/categoryHints';
import { editOrderNotify } from '../lib/telegram';

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
      // "В доставке" теперь — сумма picked (курьер забрал) и in_transit
      // (в пути), т.к. отдельного статуса "assembled" в новой цепочке нет.
      inDelivery: allOrders.filter((o) => o.status === 'picked' || o.status === 'in_transit').length,
      delivered: allOrders.filter((o) => o.status === 'delivered').length,
      cancelled: allOrders.filter((o) => o.status === 'cancelled').length,
    });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /dashboard упал');
    res.status(500).json({ error: 'Не удалось получить статистику', details: String(err?.message ?? err) });
  }
});

// Список заказов приложения — для вкладки «My Market» в админке.
/**
 * Баннеры главной приложения — 4 фиксированных слота (0..3). GET всегда
 * возвращает ровно 4 записи (создаёт пустые "выключенные" слоты, если их
 * ещё нет в базе), чтобы фронтенду не нужно было думать о недостающих слотах.
 */
shopAdminRouter.get('/banners', async (_req, res) => {
  try {
    const existing = await prisma.shopBanner.findMany({ orderBy: { slot: 'asc' } });
    const bySlot = new Map(existing.map((b) => [b.slot, b]));
    const result = [0, 1, 2, 3].map((slot) => bySlot.get(slot) ?? {
      slot, imageUrl: null, title: null, subtitle: null, linkType: null, linkValue: null, active: false,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось получить баннеры', details: String(err?.message ?? err) });
  }
});

const bannerSchema = z.object({
  imageUrl: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  subtitle: z.string().optional().nullable(),
  linkType: z.enum(['sku', 'category']).optional().nullable(),
  linkValue: z.string().optional().nullable(),
  active: z.boolean().optional(),
});

shopAdminRouter.put('/banners/:slot', async (req, res) => {
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 3) {
    return res.status(400).json({ error: 'Слот должен быть числом от 0 до 3' });
  }
  const parsed = bannerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const banner = await prisma.shopBanner.upsert({
      where: { slot },
      update: parsed.data,
      create: { slot, ...parsed.data },
    });
    res.json(banner);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось сохранить баннер', details: String(err?.message ?? err) });
  }
});

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
    // "Все" (status не передан) — это ВСЕ, КРОМЕ отменённых. Отменённые
    // заказы видны только на отдельной вкладке "Отменён" (status=cancelled
    // явно), чтобы не путались с активными на вкладке "Все".
    const where = status ? { status } : { status: { not: 'cancelled' } };
    const orders = await prisma.shopOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { courier: true, payout: true }, // курьер и выплата — только у доставленных, у остальных null
    });
    res.json(orders.map((o) => ({ ...o, items: JSON.parse(o.items) })));
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /orders упал');
    res.status(500).json({ error: 'Не удалось получить заказы', details: String(err?.message ?? err) });
  }
});

const WAYBILL_ZIP_LIMIT = 50;

// Русские метки для имени файла — те же, что на вкладках, но в имени
// файла без заглавных букв и пробелов (дефис вместо пробела).
const WAYBILL_ZIP_STATUS_LABELS: Record<string, string> = {
  '': 'все',
  pending_payment: 'ожидает-оплаты',
  paid: 'оплачен',
  picked: 'курьер-забрал',
  in_transit: 'в-пути',
  delivered: 'выдан',
  cancelled: 'отменён',
};

/**
 * ZIP-пачка накладных для текущей открытой вкладки заказов. ВАЖНО:
 * зарегистрирован ДО GET /orders/:id ниже — иначе Express принял бы
 * "waybills-zip" за параметр :id и сюда бы запрос никогда не долетал.
 *
 * Отменённые заказы НИКОГДА не попадают в пачку — даже если явно запросить
 * status=cancelled (тогда результат после фильтра будет пуст, и это
 * корректно даёт "Нет заказов для печати", а не отдельный частный случай).
 * Один и тот же generateWaybillPdf, что и у одиночной кнопки «Накладная» —
 * макет гарантированно тот же самый, не отдельная копия логики.
 */
shopAdminRouter.get('/orders/waybills-zip', async (req, res) => {
  try {
    const status = (req.query.status as string) || '';
    const baseWhere = status ? { status } : { status: { not: 'cancelled' } };
    const allMatching = await prisma.shopOrder.findMany({ where: baseWhere, orderBy: { createdAt: 'desc' } });
    const eligible = allMatching.filter((o) => o.status !== 'cancelled');

    if (!eligible.length) {
      return res.status(404).json({ error: 'Нет заказов для печати' });
    }

    const total = eligible.length;
    const batch = eligible.slice(0, WAYBILL_ZIP_LIMIT);

    const zip = new JSZip();
    let includedCount = 0;
    for (const order of batch) {
      let items: WaybillOrderItem[] = [];
      try {
        items = (JSON.parse(order.items) as Array<{ sku: string; name: string; quantity: number }>)
          .map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity }));
      } catch {
        items = [];
      }
      try {
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
        zip.file(`waybill-${order.number}.pdf`, pdfBuffer);
        includedCount += 1;
      } catch (err: any) {
        // Один заказ не собрался (например, не заполнен адрес) — просто
        // пропускаем его, остальные в архив всё равно попадают, весь
        // запрос не роняем.
        logger.warn({ err: String(err?.message ?? err), orderNumber: order.number }, '[Shop Admin] Накладная для заказа не собралась — пропущена в ZIP-пачке');
      }
    }

    if (!includedCount) {
      return res.status(500).json({ error: 'Ни одна накладная не собралась' });
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const label = WAYBILL_ZIP_STATUS_LABELS[status] ?? status;
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `nakladnye-${label}-${dateStr}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="waybills.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    // Фронт читает эти два заголовка, чтобы показать "скачано N из M",
    // если пачка была обрезана лимитом.
    res.setHeader('X-Waybills-Total', String(total));
    res.setHeader('X-Waybills-Included', String(includedCount));
    res.setHeader('Access-Control-Expose-Headers', 'X-Waybills-Total, X-Waybills-Included');
    res.send(zipBuffer);
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] Ошибка сборки ZIP-пачки накладных');
    res.status(500).json({ error: 'Не удалось собрать пачку накладных', details: String(err?.message ?? err) });
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

const statusSchema = z.object({ status: z.enum(['pending_payment', 'paid', 'picked', 'in_transit', 'delivered', 'cancelled']) });

// Ручная смена статуса из админки (например, "picked"/"in_transit" — товар
// готов к выдаче; "cancelled" — отмена). Оплата (-> paid) и выдача
// (-> delivered) обычно идут через свои специализированные эндпоинты
// (/api/shop/orders/:id/paid и /api/courier/deliver), но этот путь
// оставлен для ручной корректировки статуса из админки при необходимости.
shopAdminRouter.post('/orders/:id/status', async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const order = await prisma.shopOrder.update({ where: { id: req.params.id }, data: { status: parsed.data.status } });
    // Отмена и отсюда (не только через клиентский /orders/:id/cancel) правит
    // то же Telegram-сообщение. «paid» этот путь не проставляет статус
    // напрямую через markShopOrderAsPaid, поэтому здесь его не трогаем —
    // см. отдельную кнопку «Отметить оплаченным».
    if (parsed.data.status === 'cancelled') {
      editOrderNotify(order, 'cancelled').catch((err) => logger.error({ err }, '[Telegram] editOrderNotify(cancelled) не должен был бросить исключение'));
    }
    res.json(order);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось изменить статус заказа', details: String(err?.message ?? err) });
  }
});

/** Отметить выплату курьеру как выполненную — кнопка «Выплачено» в
 *  «Заказы APP» у доставленных заказов. */
/**
 * Кнопка «Отметить оплаченным» в «Заказы APP» — пока нет реальной
 * интеграции с эквайрингом, это единственный способ перевести заказ в
 * paid и протестировать весь дальнейший путь (курьер, выплата и т.д.).
 * Разрешено ТОЛЬКО из pending_payment — из любого другого статуса
 * отклоняем (409), не переводим повторно и не "чиним" чужой статус
 * этой кнопкой.
 *
 * Код выдачи здесь НЕ создаётся и НЕ трогается — теперь код появляется
 * только когда курьер сам его запросит (/api/shop/courier/request-code),
 * непосредственно перед выдачей, а не заранее при оплате.
 *
 * Списание остатка и создание Order/OrderItem для юнит-экономики —
 * ТОЧНО ТА ЖЕ функция markShopOrderAsPaid, что использует клиентский
 * /orders/:id/paid — поэтому повторное списание при уже списанном на
 * этапе создания остатке физически исключено (первым делом там же
 * проверяется, что заказ всё ещё pending_payment).
 */
shopAdminRouter.post('/orders/:id/mark-paid', async (req, res) => {
  try {
    const order = await prisma.shopOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    if (order.status !== 'pending_payment') {
      return res.status(409).json({ error: `Заказ в статусе "${order.status}" — отметить оплаченным можно только заказ «Ожидает оплаты»` });
    }

    const result = await markShopOrderAsPaid(order.id);
    if (!result.ok) {
      // Между проверкой выше и этим вызовом заказ успел измениться
      // (гонка) — сообщаем честно, не притворяемся, что всё получилось.
      return res.status(409).json({ error: 'Заказ уже был обработан — попробуйте обновить страницу' });
    }

    res.json({ ok: true, status: 'paid' });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] Ошибка отметки заказа оплаченным');
    res.status(500).json({ error: 'Не удалось отметить заказ оплаченным', details: String(err?.message ?? err) });
  }
});

shopAdminRouter.post('/payouts/:orderId/paid', async (req, res) => {
  try {
    const payout = await prisma.courierPayout.findUnique({ where: { orderId: req.params.orderId } });
    if (!payout) return res.status(404).json({ error: 'Выплата не найдена для этого заказа' });
    if (payout.status === 'paid') return res.status(409).json({ error: 'Уже отмечено как выплачено' });
    const updated = await prisma.courierPayout.update({
      where: { id: payout.id },
      data: { status: 'paid', paidAt: new Date() },
    });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось отметить выплату', details: String(err?.message ?? err) });
  }
});

/**
 * Массовая загрузка Excel — ТОЛЬКО для витрины My Market, отдельно от
 * общей загрузки товаров (там другие обязательные поля и другой смысл).
 * Обязательные колонки: sku, name, category, type — строка без category
 * ИЛИ type целиком отклоняется (не загружается, не "чинится" дефолтом).
 */
// Тот же принцип, что и в products.routes.ts: shopArticle сюда не добавлять —
// Excel не может вписать артикул витрины (в т.ч. вида ozon-/wb-/kaspi-...),
// он всегда только сгенерирован сервером (см. maybeGenerateShopArticle ниже).
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
  videoUrl: z.string().optional().nullable(),
});

shopAdminRouter.post('/bulk-upsert', async (req, res) => {
  const bodySchema = z.object({ products: z.array(z.record(z.any())).min(1).max(20) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверный формат данных', details: parsed.error.flatten() });

  // ВАЖНО (иначе рвётся 504 на Vercel Hobby): раньше на каждую строку было
  // ДВА последовательных обращения к БД (findFirst + create/update) — для
  // 42 товаров это до 84 обращений подряд, легко выходит за ~10 секунд,
  // которые Vercel Hobby реально даёт функции. Теперь: ОДИН groupped-запрос
  // (findMany по всем sku пачки разом), чтобы узнать, кто уже есть, плюс
  // upsert на строку (одно обращение вместо потенциальных двух). Пачка
  // здесь и так небольшая (см. лимит .max(20) выше — фронт шлёт по 8-10 за
  // раз), так что и без этой оптимизации стало бы лучше, но вместе — с
  // хорошим запасом.
  const bodySkus = parsed.data.products.map((r: any) => r?.sku).filter((s: any): s is string => typeof s === 'string' && s.length > 0);
  const existingProducts: Map<string, { sku: string; shopArticle: string | null }> = new Map(
    bodySkus.length
      ? (await prisma.product.findMany({ where: { sku: { in: bodySkus } }, select: { sku: true, shopArticle: true } })).map(
          (p: { sku: string; shopArticle: string | null }) => [p.sku, p],
        )
      : [],
  );
  const existingSkus = new Set(existingProducts.keys());

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
      // Жёсткий список разделов витрины — категория вне списка сохраняется
      // «как есть» (см. config/shopCategories.ts), но «В продаже» для такой
      // строки включить нельзя: даже если в файле стоит «да», понижаем до
      // «нет», не отклоняя всю строку целиком (остальные поля всё же нужны).
      const categoryValid = isValidShopCategory(row.data.category);
      const shopActive = row.data.shopActive && categoryValid;
      if (row.data.shopActive && !categoryValid) {
        errors.push(`${row.data.sku}: категория «${row.data.category}» не из списка разделов витрины — сохранено, но «В продаже» не включено`);
      }
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
        shopActive,
        videoUrl: row.data.videoUrl || null,
        // Excel с shopActive=да возвращает товар из архива витрины.
        ...(shopActive ? { shopArchived: false } : {}),
      };
      // Артикул витрины — та же логика, что и в карточке (см.
      // services/shopArticle.ts): строка Excel всегда приходит с заполненной
      // ценой (обязательное поле шаблона), поэтому генерируется у всех НОВЫХ
      // товаров и у уже существующих, если артикула ещё не было.
      const existingArticle = existingProducts.get(row.data.sku)?.shopArticle ?? null;
      const article = await maybeGenerateShopArticle({
        currentShopArticle: existingArticle,
        effectivePrice: data.shopPrice,
        effectiveActive: data.shopActive,
      });
      if (article) (data as Record<string, unknown>).shopArticle = article;
      const wasExisting = existingSkus.has(row.data.sku);
      await prisma.product.upsert({
        where: { sku: row.data.sku },
        update: data,
        create: { sku: row.data.sku, costPrice: 0, ...data },
      });
      if (wasExisting) updated += 1; else created += 1;
    } catch (err: any) {
      errors.push(`${row.data.sku}: ${String(err?.message ?? err)}`);
    }
  }

  res.json({ ok: true, created, updated, errors });
});

// =====================================================================
// Курьеры — вкладка «Курьеры» в My Market. Фото (удостоверение/лицо) и
// прочие личные данные отдаются ТОЛЬКО отсюда (админский путь) — ни один
// эндпоинт /api/shop/courier/* (курьерский, x-app-key) их не возвращает.
// =====================================================================

shopAdminRouter.get('/couriers', async (_req, res) => {
  try {
    // Явно без кэша — этот список должен ВСЕГДА показывать актуальное
    // состояние БД, а не что-то, что мог закэшировать браузер/прокси/CDN.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const couriers = await prisma.courier.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(couriers);
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /couriers упал');
    res.status(500).json({ error: 'Не удалось получить список курьеров', details: String(err?.message ?? err) });
  }
});

const courierBlockSchema = z.object({ active: z.boolean() });

/** Заблокировать/разблокировать курьера — кнопка «Заблокировать» в
 *  карточке (переключается на «Разблокировать», если уже заблокирован,
 *  чтобы не было тупикового состояния без возможности отменить). */
shopAdminRouter.post('/couriers/:id/block', async (req, res) => {
  const parsed = courierBlockSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const courier = await prisma.courier.update({ where: { id: req.params.id }, data: { active: parsed.data.active } });
    res.json(courier);
  } catch (err: any) {
    res.status(500).json({ error: 'Не удалось изменить статус курьера', details: String(err?.message ?? err) });
  }
});

// =====================================================================
// Аналитика витрины My Market — период 7/30 дней, только канал APP.
// Три подвкладки: поиск, конверсия по SKU, сезонность + города.
// =====================================================================

function parseAnalyticsDays(req: any): number {
  const raw = Number(req.query.days);
  return raw === 30 ? 30 : 7; // по умолчанию и на любое другое значение — 7
}

shopAdminRouter.get('/analytics/search', async (req, res) => {
  try {
    const rows = await getSearchAnalytics(parseAnalyticsDays(req));
    res.json(rows);
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /analytics/search упал');
    res.status(500).json({ error: 'Не удалось получить аналитику поиска', details: String(err?.message ?? err) });
  }
});

shopAdminRouter.get('/analytics/conversion', async (req, res) => {
  try {
    const rows = await getConversionAnalytics(parseAnalyticsDays(req));
    res.json(rows);
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /analytics/conversion упал');
    res.status(500).json({ error: 'Не удалось получить аналитику конверсии', details: String(err?.message ?? err) });
  }
});

shopAdminRouter.get('/analytics/seasonality', async (req, res) => {
  try {
    const data = await getSeasonalityAnalytics(parseAnalyticsDays(req));
    res.json(data);
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /analytics/seasonality упал');
    res.status(500).json({ error: 'Не удалось получить аналитику сезонности', details: String(err?.message ?? err) });
  }
});

// =====================================================================
// Архив и удаление товаров ВИТРИНЫ My Market (вкладка «Товары»).
// Ничего не вызывает на Kaspi/Ozon/WB: работает только с записью Product
// в нашей базе. Раздел учёта (active, costPrice, идентификаторы площадок,
// marketImages) не затрагивается.
// =====================================================================

const shopProductIdsSchema = z.object({ ids: z.array(z.string()).min(1).max(500) });

/**
 * Архив витрины / возврат из архива. archived=true: товар пропадает из
 * приложения (shopActive=false) и из «В продаже»/«Скрыты», остаётся во
 * вкладке «Архив». archived=false: только снимает метку — товар вернётся в
 * «Скрыты» (или «Без категории»); в продажу его включают отдельно.
 * Поле active (архив учёта) намеренно НЕ трогается.
 */
shopAdminRouter.post('/products/archive', async (req, res) => {
  const parsed = shopProductIdsSchema.extend({ archived: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await prisma.product.updateMany({
      where: { id: { in: parsed.data.ids } },
      data: parsed.data.archived ? { shopArchived: true, shopActive: false } : { shopArchived: false },
    });
    res.json({ ok: true, updated: result.count });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] POST /products/archive упал');
    res.status(500).json({ error: 'Не удалось изменить архив витрины', details: String(err?.message ?? err) });
  }
});

/**
 * «Чистый» товар витрины — существует только ради приложения: без
 * идентификаторов Kaspi/Ozon/WB и не с sku вида kaspi-/ozon-/wb-. MM-* и
 * товары из Excel My Market (SKU-001 и т.п.) сюда попадают. Всё остальное —
 * товар учёта: его запись НИКОГДА не удаляется этим эндпоинтом.
 */
function isPureShopProduct(p: {
  sku: string; kaspiSku: string | null; ozonOfferId: string | null; ozonSku: number | null;
  wbArticle: string | null; wbNmId: number | null; kaspiProductUrl: string | null;
}): boolean {
  if (/^(kaspi|ozon|wb)-/i.test(p.sku)) return false;
  return !p.kaspiSku && !p.ozonOfferId && p.ozonSku == null && !p.wbArticle && p.wbNmId == null && !p.kaspiProductUrl;
}

/**
 * «Удалить» из My Market — ТОЛЬКО для чистых товаров витрины (MM-*, товары из
 * Excel My Market): удаляется запись Product (история APP-заказов остаётся:
 * OrderItem.productId обнуляется, снимок названия/цены/себестоимости
 * сохраняется). Товар учёта (kaspi-/ozon-/wb-* и всё с идентификаторами
 * площадок) удалять и «снимать с витрины» этим эндпоинтом ЗАПРЕЩЕНО — для
 * него есть только архив витрины (/products/archive). Если среди выбранных
 * есть хотя бы один товар учёта, не удаляется ничего (409) — без частичных
 * удалений, чтобы результат был однозначным.
 */
shopAdminRouter.post('/products/remove', async (req, res) => {
  const parsed = shopProductIdsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const products = await prisma.product.findMany({
      where: { id: { in: parsed.data.ids } },
      select: { id: true, sku: true, kaspiSku: true, ozonOfferId: true, ozonSku: true, wbArticle: true, wbNmId: true, kaspiProductUrl: true },
    });
    const accounting = products.filter((p) => !isPureShopProduct(p));
    if (accounting.length) {
      return res.status(409).json({
        error: 'Товар учёта. Только архив витрины',
        accounting: accounting.length,
        skus: accounting.slice(0, 20).map((p) => p.sku),
      });
    }

    const pureIds = products.map((p) => p.id);
    const deleted = pureIds.length ? (await prisma.product.deleteMany({ where: { id: { in: pureIds } } })).count : 0;
    res.json({ ok: true, deleted, notFound: parsed.data.ids.length - products.length });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] POST /products/remove упал');
    res.status(500).json({ error: 'Не удалось убрать товары из My Market', details: String(err?.message ?? err) });
  }
});

// =====================================================================
// Словарь соответствий «тип Ozon -> category + type My Market».
// Сырую категорию Ozon в карточки не пишем и тип по названию не угадываем:
// category/type ставятся ТОЛЬКО по записи из этого словаря.
// =====================================================================

/** Типы Ozon, встречающиеся у товаров (с числом товаров) + соответствия. */
shopAdminRouter.get('/ozon-type-map', async (_req, res) => {
  try {
    const groups = await prisma.product.groupBy({ by: ['ozonType'], where: { ozonType: { not: null } }, _count: { _all: true } });
    const maps = await prisma.ozonTypeMap.findMany();
    const mapByKey = new Map<string, { ozonTypeLabel: string; category: string; type: string }>(
      maps.map((m: { ozonTypeKey: string; ozonTypeLabel: string; category: string; type: string }) => [m.ozonTypeKey, m]),
    );

    const rows = new Map<string, { ozonType: string; count: number; category: string | null; type: string | null; mapped: boolean }>();
    for (const g of groups as Array<{ ozonType: string | null; _count: { _all: number } }>) {
      if (!g.ozonType) continue;
      const key = ozonTypeKey(g.ozonType);
      const hit = mapByKey.get(key);
      const prev = rows.get(key);
      rows.set(key, {
        ozonType: prev?.ozonType ?? g.ozonType,
        count: (prev?.count ?? 0) + g._count._all,
        category: hit?.category ?? null,
        type: hit?.type ?? null,
        mapped: !!hit,
      });
    }
    // Соответствия, по которым сейчас нет ни одного товара, тоже показываем.
    for (const [key, m] of mapByKey) {
      if (!rows.has(key)) rows.set(key, { ozonType: m.ozonTypeLabel, count: 0, category: m.category, type: m.type, mapped: true });
    }
    const list = Array.from(rows.values()).sort((a, b) => Number(a.mapped) - Number(b.mapped) || b.count - a.count || a.ozonType.localeCompare(b.ozonType, 'ru'));
    res.json(list);
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /ozon-type-map упал');
    res.status(500).json({ error: 'Не удалось получить словарь типов Ozon', details: String(err?.message ?? err) });
  }
});

const ozonTypeMapSchema = z.object({
  ozonType: z.string().trim().min(1),
  category: z.string().trim().min(1),
  type: z.string().trim().min(1),
});

/**
 * Сохранить соответствие и сразу применить его к уже загруженным товарам
 * этого типа Ozon — но только к тем, у кого category И type пусты либо были
 * проставлены словарём раньше. Вручную заполненные карточки не перезаписываются.
 */
shopAdminRouter.put('/ozon-type-map', async (req, res) => {
  const parsed = ozonTypeMapSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { ozonType, category, type } = parsed.data;
  try {
    const key = ozonTypeKey(ozonType);
    await prisma.ozonTypeMap.upsert({
      where: { ozonTypeKey: key },
      update: { ozonTypeLabel: ozonType, category, type },
      create: { ozonTypeKey: key, ozonTypeLabel: ozonType, category, type },
    });
    const applied = await prisma.product.updateMany({
      where: {
        ozonType: { equals: ozonType, mode: 'insensitive' },
        OR: [{ AND: [{ category: null }, { type: null }] }, { categorySource: 'dictionary' }],
      },
      data: { category, type, categorySource: 'dictionary' },
    });
    res.json({ ok: true, applied: applied.count });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] PUT /ozon-type-map упал');
    res.status(500).json({ error: 'Не удалось сохранить соответствие', details: String(err?.message ?? err) });
  }
});

// =====================================================================
// Категория и тип «по названию» — подсказка, а не публикация. Правила и
// справочник — в services/categoryHints.ts (дерево Ozon не используется).
// Ничего из этого не включает продажу и не затирает заполненные поля.
// =====================================================================

/**
 * Каталог «категория → её типы» для выпадающих списков в карточке:
 * стартовый список + справочник правил + свои типы (ShopCategoryType) + соответствия из словаря Ozon (уже My Market-значения)
 * + пары, реально использованные в товарах. Дерево категорий Ozon не берётся.
 */
shopAdminRouter.get('/category-catalog', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const used = await prisma.product.groupBy({
      by: ['category', 'type'],
      where: { category: { not: null }, type: { not: null } },
    });
    const mapped = await prisma.ozonTypeMap.findMany({ select: { category: true, type: true } });
    const custom = await prisma.shopCategoryType.findMany({ select: { category: true, type: true }, orderBy: { createdAt: 'asc' } });
    const categories = buildCatalog([
      ...starterCatalogPairs(),
      ...hintRuleCatalogPairs(),
      ...(custom as Array<{ category: string; type: string }>),
      ...(mapped as Array<{ category: string; type: string }>),
      ...(used as Array<{ category: string | null; type: string | null }>),
    ]);
    res.json({ categories });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] GET /category-catalog упал');
    res.status(500).json({ error: 'Не удалось получить каталог категорий', details: String(err?.message ?? err) });
  }
});

/** Варианты category/type по названию (для блока «По названию» в карточке). */
shopAdminRouter.get('/category-hints', (req, res) => {
  res.json(hintCategoryByName(String(req.query.name ?? '')));
});

/**
 * Пакетная простановка category/type по названию. Только для товаров, у
 * которых category И type пусты (заполненное — в том числе руками — не
 * трогается), и только когда подходит ровно один вариант; спорные и без
 * совпадений остаются пустыми. shopActive не меняется. Источник помечается
 * categorySource="name" — так в списке видно «категория с названия».
 * Клиент шлёт id пачками (до 500), чтобы уложиться в лимит serverless.
 */
shopAdminRouter.post('/products/apply-name-categories', async (req, res) => {
  const parsed = shopProductIdsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const products = await prisma.product.findMany({
      where: { id: { in: parsed.data.ids } },
      select: { id: true, name: true, category: true, type: true },
    });
    let alreadyFilled = 0;
    let multiple = 0;
    let none = 0;
    const groups = new Map<string, { category: string; type: string; ids: string[] }>();
    for (const p of products as Array<{ id: string; name: string; category: string | null; type: string | null }>) {
      if (p.category || p.type) { alreadyFilled += 1; continue; }
      const hint = hintCategoryByName(p.name);
      if (hint.status === 'multiple') { multiple += 1; continue; }
      if (hint.status === 'none') { none += 1; continue; }
      const v = hint.variants[0];
      const key = `${v.category}|${v.type}`;
      if (!groups.has(key)) groups.set(key, { category: v.category, type: v.type, ids: [] });
      groups.get(key)!.ids.push(p.id);
    }

    let applied = 0;
    for (const g of groups.values()) {
      // category/type: null в условии — защита от гонки: если поле успели
      // заполнить между чтением и записью, оно не будет перезаписано.
      const r = await prisma.product.updateMany({
        where: { id: { in: g.ids }, category: null, type: null },
        data: { category: g.category, type: g.type, categorySource: 'name' },
      });
      applied += r.count;
    }
    res.json({ ok: true, applied, multiple, none, alreadyFilled, notFound: parsed.data.ids.length - products.length });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] POST /products/apply-name-categories упал');
    res.status(500).json({ error: 'Не удалось проставить категории по названиям', details: String(err?.message ?? err) });
  }
});

/**
 * Свой тип, вписанный в карточке («+ Свой тип…»): попадает в каталог своей
 * категории и в следующий раз уже есть в выпадающем списке. Идемпотентно —
 * повтор (в том числе с другим регистром) второй раз не создаёт. Подкатегория
 * здесь не участвует: тип не хранится «вместо» подкатегории и не дублирует её.
 */
shopAdminRouter.post('/category-types', async (req, res) => {
  const parsed = z.object({ category: z.string().min(1).max(200), type: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const category = parsed.data.category.replace(/\s+/g, ' ').trim();
  const type = parsed.data.type.replace(/\s+/g, ' ').trim();
  if (!category || !type) return res.status(400).json({ error: 'Категория и тип не должны быть пустыми' });
  if (type.length > 60) return res.status(400).json({ error: 'Тип слишком длинный (максимум 60 символов)' });
  try {
    // Дубль проверяем по ВСЕМУ каталогу (стартовый список + свои типы), не
    // только по своей таблице — иначе тип из стартового списка («Краска для
    // волос» и т.п.) плодил бы лишнюю запись при первом же ручном вводе.
    const [custom] = await Promise.all([prisma.shopCategoryType.findMany({ select: { category: true, type: true } })]);
    const catalog = buildCatalog([...starterCatalogPairs(), ...hintRuleCatalogPairs(), ...(custom as Array<{ category: string; type: string }>)]);
    const existingType = catalog
      .find((c) => c.category.toLowerCase() === category.toLowerCase())
      ?.types.find((t) => t.toLowerCase() === type.toLowerCase());
    if (existingType) return res.json({ ok: true, created: false, type: existingType });
    const row = await prisma.shopCategoryType.create({ data: { category, type } });
    res.status(201).json({ ok: true, created: true, type: row.type });
  } catch (err: any) {
    logger.error({ err }, '[Shop Admin] POST /category-types упал');
    res.status(500).json({ error: 'Не удалось добавить тип', details: String(err?.message ?? err) });
  }
});

