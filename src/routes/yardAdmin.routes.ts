import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { normalizePhone } from './shop.routes';
import { yardApplyPayment, yardApplyAccept, yardApplyClose, YardTransitionError } from '../services/yard.service';

export const yardAdminRouter = Router();

// =====================================================================
// Вакансия — админ сам вписывает телефон/имя/фамилию/ИИН.
// =====================================================================
const inviteSchema = z.object({
  phone: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  iin: z.string().min(1),
});

/** Одна запись на телефон — повторная отправка на тот же номер обновляет её. */
yardAdminRouter.post('/invites', async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const phone = normalizePhone(parsed.data.phone);
    if (!phone) return res.status(400).json({ error: 'Некорректный номер телефона' });

    const invite = await prisma.yardInvite.upsert({
      where: { phone },
      update: { firstName: parsed.data.firstName, lastName: parsed.data.lastName, iin: parsed.data.iin },
      create: { phone, firstName: parsed.data.firstName, lastName: parsed.data.lastName, iin: parsed.data.iin },
    });
    res.status(201).json(invite);
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /invites упал');
    res.status(500).json({ error: 'Не удалось отправить вакансию', details: String(err?.message ?? err) });
  }
});

// =====================================================================
// Заявки — список, «Одобрить»/«Отказать». Одобрение открывает кабинет,
// создавая YardShop из данных заявки.
// =====================================================================

yardAdminRouter.get('/applications', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const applications = await prisma.yardApplication.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(applications);
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] GET /applications упал');
    res.status(500).json({ error: 'Не удалось получить заявки двора', details: String(err?.message ?? err) });
  }
});

/**
 * «Одобрить» — ровно здесь открывается кабинет: создаём (или обновляем,
 * если уже была раньше при повторном одобрении) YardShop из данных
 * заявки. До этого вызова товары грузить было нельзя (POST
 * /yard/mine/items отвечал 404 — не было YardShop для этого телефона).
 */
yardAdminRouter.post('/applications/:id/approve', async (req, res) => {
  try {
    const application = await prisma.yardApplication.findUnique({ where: { id: req.params.id } });
    if (!application) return res.status(404).json({ error: 'Заявка не найдена' });

    const [updatedApplication] = await prisma.$transaction([
      prisma.yardApplication.update({ where: { id: req.params.id }, data: { status: 'approved', reviewedAt: new Date() } }),
      prisma.yardShop.upsert({
        where: { phone: application.phone },
        update: { name: application.shopName, photo: application.shopPhoto, lat: application.lat, lng: application.lng },
        create: {
          phone: application.phone,
          name: application.shopName,
          photo: application.shopPhoto,
          lat: application.lat,
          lng: application.lng,
        },
      }),
    ]);
    res.json(updatedApplication);
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /applications/:id/approve упал');
    res.status(500).json({ error: 'Не удалось одобрить заявку', details: String(err?.message ?? err) });
  }
});

/** «Отказать» — кабинет не открывается, YardShop не создаётся. */
yardAdminRouter.post('/applications/:id/reject', async (req, res) => {
  try {
    const application = await prisma.yardApplication.update({
      where: { id: req.params.id },
      data: { status: 'rejected', reviewedAt: new Date() },
    });
    res.json(application);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Заявка не найдена' });
    logger.error({ err }, '[Yard Admin] POST /applications/:id/reject упал');
    res.status(500).json({ error: 'Не удалось отклонить заявку', details: String(err?.message ?? err) });
  }
});

const deleteApplicationsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

/**
 * Удалить заявки пачкой (только отмеченные галочкой) — стирает записи на
 * сервере. Удаляется ТОЛЬКО сама заявка: магазин, созданный при одобрении,
 * остаётся (им управляют вкладки «Магазины»/«Архив»), вакансия тоже. Если
 * заявку удалили, человек с приглашённым номером сможет подать новую.
 */
yardAdminRouter.post('/applications/delete', async (req, res) => {
  const parsed = deleteApplicationsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const r = await prisma.yardApplication.deleteMany({ where: { id: { in: parsed.data.ids } } });
    res.json({ deleted: r.count });
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /applications/delete упал');
    res.status(500).json({ error: 'Не удалось удалить заявки', details: String(err?.message ?? err) });
  }
});

// =====================================================================
// Магазины, Полки, Заказы — без изменений от исходной логики.
// =====================================================================

yardAdminRouter.get('/shops', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // По умолчанию — только живые; архив — отдельным запросом ?archived=true.
    const archived = req.query.archived === 'true';
    const shops = await prisma.yardShop.findMany({ where: { archived }, orderBy: { createdAt: 'desc' } });
    res.json(shops);
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] GET /shops упал');
    res.status(500).json({ error: 'Не удалось получить магазины двора', details: String(err?.message ?? err) });
  }
});

const subscriptionSchema = z.object({
  paidUntil: z.string().datetime().optional(),
  months: z.number().int().positive().optional(),
}).refine((d) => d.paidUntil || d.months, { message: 'Укажите paidUntil или months' });

/** Подписка 500 ₸/мес — вручную, админ сам проставляет paidUntil. С пакета комиссию не берём. */
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

yardAdminRouter.get('/items', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // Товары архивного магазина «лежат» внутри его архива — ни в живом списке, ни в архиве полок их нет.
    const archived = req.query.archived === 'true';
    const items = await prisma.yardItem.findMany({
      where: { archived, shop: { archived: false } },
      include: { shop: { select: { name: true } } },
    });
    res.json(items);
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] GET /items упал');
    res.status(500).json({ error: 'Не удалось получить товары двора', details: String(err?.message ?? err) });
  }
});

yardAdminRouter.get('/orders', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const archived = req.query.archived === 'true';
    const orders = await prisma.yardOrder.findMany({
      where: { archived, shop: { archived: false } },
      include: { items: true, shop: { select: { name: true, phone: true } }, messages: true },
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

// =====================================================================
// Архив / возврат из архива / удаление / переименование.
// Работают ТОЛЬКО с теми id, которые прислал админ (отмеченные галочкой) —
// «без галочки строки не трогаем». Удаление стирает записи с сервера.
// =====================================================================
const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
const idsArchiveSchema = idsSchema.extend({ archived: z.boolean() });
const shelvesSchema = z.object({ shopIds: z.array(z.string().min(1)).min(1).max(500) });
const shelvesArchiveSchema = shelvesSchema.extend({ archived: z.boolean() });
const shelvesDeleteSchema = shelvesSchema.extend({ archived: z.boolean() });

/** Магазины: в архив (archived:true) / вернуть (archived:false). Архивный магазин покупателям не виден. */
yardAdminRouter.post('/shops/archive', async (req, res) => {
  const parsed = idsArchiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const r = await prisma.yardShop.updateMany({ where: { id: { in: parsed.data.ids } }, data: { archived: parsed.data.archived } });
    res.json({ updated: r.count });
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /shops/archive упал');
    res.status(500).json({ error: 'Не удалось изменить архив магазинов', details: String(err?.message ?? err) });
  }
});

/**
 * Магазины: удалить с сервера. Внешние ключи RESTRICT, поэтому порядок от
 * дочерних к родителю: сообщения заказов -> позиции заказов -> заказы ->
 * чат магазина -> товары полки -> магазин. Заявка/вакансия по этому телефону
 * остаются как были (их ведёт вкладка «Заявки»).
 */
yardAdminRouter.post('/shops/delete', async (req, res) => {
  const parsed = idsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const ids = parsed.data.ids;
    const orders = await prisma.yardOrder.findMany({ where: { shopId: { in: ids } }, select: { id: true } });
    const orderIds = orders.map((o: { id: string }) => o.id);
    const [, , , , , shops] = await prisma.$transaction([
      prisma.yardMessage.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.yardOrderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.yardOrder.deleteMany({ where: { shopId: { in: ids } } }),
      prisma.yardShopMessage.deleteMany({ where: { shopId: { in: ids } } }),
      prisma.yardItem.deleteMany({ where: { shopId: { in: ids } } }),
      prisma.yardShop.deleteMany({ where: { id: { in: ids } } }),
    ]);
    res.json({ deleted: shops.count });
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /shops/delete упал');
    res.status(500).json({ error: 'Не удалось удалить магазины', details: String(err?.message ?? err) });
  }
});

/** Полки (строка = полка магазина): в архив / вернуть. Затрагивает все товары магазина в нужном состоянии. */
yardAdminRouter.post('/items/archive', async (req, res) => {
  const parsed = shelvesArchiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const r = await prisma.yardItem.updateMany({
      where: { shopId: { in: parsed.data.shopIds }, archived: !parsed.data.archived },
      data: { archived: parsed.data.archived },
    });
    res.json({ updated: r.count });
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /items/archive упал');
    res.status(500).json({ error: 'Не удалось изменить архив полок', details: String(err?.message ?? err) });
  }
});

/**
 * Полки: удалить товары выбранных магазинов — живые (archived:false, из общего
 * списка) или архивные (archived:true, из архива). Позиции уже сделанных
 * заказов хранят снимок названия/цены и ссылаются на товар без внешнего
 * ключа, поэтому заказы остаются целыми.
 */
yardAdminRouter.post('/items/delete', async (req, res) => {
  const parsed = shelvesDeleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const r = await prisma.yardItem.deleteMany({ where: { shopId: { in: parsed.data.shopIds }, archived: parsed.data.archived } });
    res.json({ deleted: r.count });
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /items/delete упал');
    res.status(500).json({ error: 'Не удалось удалить товары', details: String(err?.message ?? err) });
  }
});

/** Заказы: в архив / вернуть. Статус, остаток и деньги не трогаем. */
yardAdminRouter.post('/orders/archive', async (req, res) => {
  const parsed = idsArchiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const r = await prisma.yardOrder.updateMany({ where: { id: { in: parsed.data.ids } }, data: { archived: parsed.data.archived } });
    res.json({ updated: r.count });
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /orders/archive упал');
    res.status(500).json({ error: 'Не удалось изменить архив заказов', details: String(err?.message ?? err) });
  }
});

/** Заказы: удалить с сервера вместе с позициями и перепиской по заказу. Остаток на полку не возвращается. */
yardAdminRouter.post('/orders/delete', async (req, res) => {
  const parsed = idsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const ids = parsed.data.ids;
    const [, , orders] = await prisma.$transaction([
      prisma.yardMessage.deleteMany({ where: { orderId: { in: ids } } }),
      prisma.yardOrderItem.deleteMany({ where: { orderId: { in: ids } } }),
      prisma.yardOrder.deleteMany({ where: { id: { in: ids } } }),
    ]);
    res.json({ deleted: orders.count });
  } catch (err: any) {
    logger.error({ err }, '[Yard Admin] POST /orders/delete упал');
    res.status(500).json({ error: 'Не удалось удалить заказы', details: String(err?.message ?? err) });
  }
});

const renameShopSchema = z.object({ name: z.string().trim().min(1).max(100) });

/** Открыть магазин, поправить название и сохранить. Больше ничего в магазине эта правка не меняет. */
yardAdminRouter.post('/shops/:id/rename', async (req, res) => {
  const parsed = renameShopSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Название не может быть пустым', details: parsed.error.flatten() });
  try {
    const shop = await prisma.yardShop.update({ where: { id: req.params.id }, data: { name: parsed.data.name } });
    res.json(shop);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Магазин не найден' });
    logger.error({ err }, '[Yard Admin] POST /shops/:id/rename упал');
    res.status(500).json({ error: 'Не удалось переименовать магазин', details: String(err?.message ?? err) });
  }
});

/** Оборот двора — отдельно от юнит-экономики APP: комиссия 0, налог не считаем. */
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
