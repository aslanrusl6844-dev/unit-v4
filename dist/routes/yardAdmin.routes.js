"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.yardAdminRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const pushBroadcast_service_1 = require("../services/pushBroadcast.service");
const logger_1 = require("../utils/logger");
const shop_routes_1 = require("./shop.routes");
const yard_service_1 = require("../services/yard.service");
exports.yardAdminRouter = (0, express_1.Router)();
// =====================================================================
// Вакансия — админ сам вписывает телефон/имя/фамилию/ИИН.
// =====================================================================
const inviteSchema = zod_1.z.object({
    phone: zod_1.z.string().min(1),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    iin: zod_1.z.string().min(1),
});
/** Одна запись на телефон — повторная отправка на тот же номер обновляет её. */
exports.yardAdminRouter.post('/invites', async (req, res) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const phone = (0, shop_routes_1.normalizePhone)(parsed.data.phone);
        if (!phone)
            return res.status(400).json({ error: 'Некорректный номер телефона' });
        const invite = await prisma_1.prisma.yardInvite.upsert({
            where: { phone },
            update: { firstName: parsed.data.firstName, lastName: parsed.data.lastName, iin: parsed.data.iin },
            create: { phone, firstName: parsed.data.firstName, lastName: parsed.data.lastName, iin: parsed.data.iin },
        });
        res.status(201).json(invite);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /invites упал');
        res.status(500).json({ error: 'Не удалось отправить вакансию', details: String(err?.message ?? err) });
    }
});
// =====================================================================
// Заявки — список, «Одобрить»/«Отказать». Одобрение открывает кабинет,
// создавая YardShop из данных заявки.
// =====================================================================
exports.yardAdminRouter.get('/applications', async (_req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        const applications = await prisma_1.prisma.yardApplication.findMany({ orderBy: { createdAt: 'desc' } });
        res.json(applications);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] GET /applications упал');
        res.status(500).json({ error: 'Не удалось получить заявки двора', details: String(err?.message ?? err) });
    }
});
/**
 * «Одобрить» — ровно здесь открывается кабинет: создаём (или обновляем,
 * если уже была раньше при повторном одобрении) YardShop из данных
 * заявки. До этого вызова товары грузить было нельзя (POST
 * /yard/mine/items отвечал 404 — не было YardShop для этого телефона).
 */
exports.yardAdminRouter.post('/applications/:id/approve', async (req, res) => {
    try {
        const application = await prisma_1.prisma.yardApplication.findUnique({ where: { id: req.params.id } });
        if (!application)
            return res.status(404).json({ error: 'Заявка не найдена' });
        const [updatedApplication] = await prisma_1.prisma.$transaction([
            prisma_1.prisma.yardApplication.update({ where: { id: req.params.id }, data: { status: 'approved', reviewedAt: new Date() } }),
            prisma_1.prisma.yardShop.upsert({
                where: { phone: (0, shop_routes_1.normalizePhone)(application.phone) || application.phone },
                update: { name: application.shopName, photo: application.shopPhoto, lat: application.lat, lng: application.lng },
                create: {
                    phone: (0, shop_routes_1.normalizePhone)(application.phone) || application.phone,
                    name: application.shopName,
                    photo: application.shopPhoto,
                    lat: application.lat,
                    lng: application.lng,
                },
            }),
        ]);
        res.json(updatedApplication);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /applications/:id/approve упал');
        res.status(500).json({ error: 'Не удалось одобрить заявку', details: String(err?.message ?? err) });
    }
});
/** «Отказать» — кабинет не открывается, YardShop не создаётся. */
exports.yardAdminRouter.post('/applications/:id/reject', async (req, res) => {
    try {
        const application = await prisma_1.prisma.yardApplication.update({
            where: { id: req.params.id },
            data: { status: 'rejected', reviewedAt: new Date() },
        });
        res.json(application);
    }
    catch (err) {
        if (err?.code === 'P2025')
            return res.status(404).json({ error: 'Заявка не найдена' });
        logger_1.logger.error({ err }, '[Yard Admin] POST /applications/:id/reject упал');
        res.status(500).json({ error: 'Не удалось отклонить заявку', details: String(err?.message ?? err) });
    }
});
const deleteApplicationsSchema = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(500) });
/**
 * Удалить заявки пачкой (только отмеченные галочкой) — стирает записи на
 * сервере. Удаляется ТОЛЬКО сама заявка: магазин, созданный при одобрении,
 * остаётся (им управляют вкладки «Магазины»/«Архив»), вакансия тоже. Если
 * заявку удалили, человек с приглашённым номером сможет подать новую.
 */
exports.yardAdminRouter.post('/applications/delete', async (req, res) => {
    const parsed = deleteApplicationsSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const r = await prisma_1.prisma.yardApplication.deleteMany({ where: { id: { in: parsed.data.ids } } });
        res.json({ deleted: r.count });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /applications/delete упал');
        res.status(500).json({ error: 'Не удалось удалить заявки', details: String(err?.message ?? err) });
    }
});
// =====================================================================
// Магазины, Полки, Заказы — без изменений от исходной логики.
// =====================================================================
exports.yardAdminRouter.get('/shops', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        // По умолчанию — только живые; архив — отдельным запросом ?archived=true.
        const archived = req.query.archived === 'true';
        const shops = await prisma_1.prisma.yardShop.findMany({ where: { archived }, orderBy: { createdAt: 'desc' } });
        res.json(shops);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] GET /shops упал');
        res.status(500).json({ error: 'Не удалось получить магазины двора', details: String(err?.message ?? err) });
    }
});
const subscriptionSchema = zod_1.z.object({
    paidUntil: zod_1.z.string().datetime().optional(),
    months: zod_1.z.number().int().positive().optional(),
}).refine((d) => d.paidUntil || d.months, { message: 'Укажите paidUntil или months' });
/** Подписка 500 ₸/мес — вручную, админ сам проставляет paidUntil. С пакета комиссию не берём. */
exports.yardAdminRouter.post('/shops/:id/subscription', async (req, res) => {
    const parsed = subscriptionSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const shop = await prisma_1.prisma.yardShop.findUnique({ where: { id: req.params.id } });
        if (!shop)
            return res.status(404).json({ error: 'Магазин не найден' });
        let paidUntil;
        if (parsed.data.paidUntil) {
            paidUntil = new Date(parsed.data.paidUntil);
        }
        else {
            const base = shop.paidUntil && shop.paidUntil.getTime() > Date.now() ? shop.paidUntil : new Date();
            paidUntil = new Date(base.getTime() + parsed.data.months * 30 * 24 * 60 * 60 * 1000);
        }
        const updated = await prisma_1.prisma.yardShop.update({ where: { id: req.params.id }, data: { paidUntil } });
        res.json(updated);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /shops/:id/subscription упал');
        res.status(500).json({ error: 'Не удалось продлить подписку', details: String(err?.message ?? err) });
    }
});
const toggleActiveSchema = zod_1.z.object({ active: zod_1.z.boolean() });
exports.yardAdminRouter.post('/shops/:id/active', async (req, res) => {
    const parsed = toggleActiveSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const updated = await prisma_1.prisma.yardShop.update({ where: { id: req.params.id }, data: { active: parsed.data.active } });
        res.json(updated);
    }
    catch (err) {
        if (err?.code === 'P2025')
            return res.status(404).json({ error: 'Магазин не найден' });
        logger_1.logger.error({ err }, '[Yard Admin] POST /shops/:id/active упал');
        res.status(500).json({ error: 'Не удалось изменить статус магазина', details: String(err?.message ?? err) });
    }
});
exports.yardAdminRouter.get('/items', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        // Товары архивного магазина «лежат» внутри его архива — ни в живом списке, ни в архиве полок их нет.
        const archived = req.query.archived === 'true';
        const items = await prisma_1.prisma.yardItem.findMany({
            where: { archived, shop: { archived: false } },
            include: { shop: { select: { name: true } } },
        });
        res.json(items);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] GET /items упал');
        res.status(500).json({ error: 'Не удалось получить товары двора', details: String(err?.message ?? err) });
    }
});
exports.yardAdminRouter.get('/orders', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        const archived = req.query.archived === 'true';
        const orders = await prisma_1.prisma.yardOrder.findMany({
            where: { archived, shop: { archived: false } },
            include: { items: true, shop: { select: { name: true, phone: true } }, messages: true },
            orderBy: { createdAt: 'desc' },
        });
        res.json(orders.map((o) => ({
            ...o,
            receiptUrl: [...o.messages].reverse().find((m) => m.imageUrl)?.imageUrl ?? null,
        })));
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] GET /orders упал');
        res.status(500).json({ error: 'Не удалось получить заказы двора', details: String(err?.message ?? err) });
    }
});
// =====================================================================
// Архив / возврат из архива / удаление / переименование.
// Работают ТОЛЬКО с теми id, которые прислал админ (отмеченные галочкой) —
// «без галочки строки не трогаем». Удаление стирает записи с сервера.
// =====================================================================
const idsSchema = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(500) });
const idsArchiveSchema = idsSchema.extend({ archived: zod_1.z.boolean() });
const shelvesSchema = zod_1.z.object({ shopIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(500) });
const shelvesArchiveSchema = shelvesSchema.extend({ archived: zod_1.z.boolean() });
const shelvesDeleteSchema = shelvesSchema.extend({ archived: zod_1.z.boolean() });
/** Магазины: в архив (archived:true) / вернуть (archived:false). Архивный магазин покупателям не виден. */
exports.yardAdminRouter.post('/shops/archive', async (req, res) => {
    const parsed = idsArchiveSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const r = await prisma_1.prisma.yardShop.updateMany({ where: { id: { in: parsed.data.ids } }, data: { archived: parsed.data.archived } });
        res.json({ updated: r.count });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /shops/archive упал');
        res.status(500).json({ error: 'Не удалось изменить архив магазинов', details: String(err?.message ?? err) });
    }
});
/**
 * Магазины: удалить с сервера. Внешние ключи RESTRICT, поэтому порядок от
 * дочерних к родителю: сообщения заказов -> позиции заказов -> заказы ->
 * чат магазина -> товары полки -> магазин. Заявка/вакансия по этому телефону
 * остаются как были (их ведёт вкладка «Заявки»).
 */
exports.yardAdminRouter.post('/shops/delete', async (req, res) => {
    const parsed = idsSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const ids = parsed.data.ids;
        const orders = await prisma_1.prisma.yardOrder.findMany({ where: { shopId: { in: ids } }, select: { id: true } });
        const orderIds = orders.map((o) => o.id);
        const [, , , , , shops] = await prisma_1.prisma.$transaction([
            prisma_1.prisma.yardMessage.deleteMany({ where: { orderId: { in: orderIds } } }),
            prisma_1.prisma.yardOrderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
            prisma_1.prisma.yardOrder.deleteMany({ where: { shopId: { in: ids } } }),
            prisma_1.prisma.yardShopMessage.deleteMany({ where: { shopId: { in: ids } } }),
            prisma_1.prisma.yardItem.deleteMany({ where: { shopId: { in: ids } } }),
            prisma_1.prisma.yardShop.deleteMany({ where: { id: { in: ids } } }),
        ]);
        res.json({ deleted: shops.count });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /shops/delete упал');
        res.status(500).json({ error: 'Не удалось удалить магазины', details: String(err?.message ?? err) });
    }
});
/** Полки (строка = полка магазина): в архив / вернуть. Затрагивает все товары магазина в нужном состоянии. */
exports.yardAdminRouter.post('/items/archive', async (req, res) => {
    const parsed = shelvesArchiveSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const r = await prisma_1.prisma.yardItem.updateMany({
            where: { shopId: { in: parsed.data.shopIds }, archived: !parsed.data.archived },
            data: { archived: parsed.data.archived },
        });
        res.json({ updated: r.count });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /items/archive упал');
        res.status(500).json({ error: 'Не удалось изменить архив полок', details: String(err?.message ?? err) });
    }
});
/**
 * Полки: удалить товары выбранных магазинов — живые (archived:false, из общего
 * списка) или архивные (archived:true, из архива). Позиции уже сделанных
 * заказов хранят снимок названия/цены и ссылаются на товар без внешнего
 * ключа, поэтому заказы остаются целыми.
 */
exports.yardAdminRouter.post('/items/delete', async (req, res) => {
    const parsed = shelvesDeleteSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const r = await prisma_1.prisma.yardItem.deleteMany({ where: { shopId: { in: parsed.data.shopIds }, archived: parsed.data.archived } });
        res.json({ deleted: r.count });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /items/delete упал');
        res.status(500).json({ error: 'Не удалось удалить товары', details: String(err?.message ?? err) });
    }
});
/** Заказы: в архив / вернуть. Статус, остаток и деньги не трогаем. */
exports.yardAdminRouter.post('/orders/archive', async (req, res) => {
    const parsed = idsArchiveSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const r = await prisma_1.prisma.yardOrder.updateMany({ where: { id: { in: parsed.data.ids } }, data: { archived: parsed.data.archived } });
        res.json({ updated: r.count });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /orders/archive упал');
        res.status(500).json({ error: 'Не удалось изменить архив заказов', details: String(err?.message ?? err) });
    }
});
/** Заказы: удалить с сервера вместе с позициями и перепиской по заказу. Остаток на полку не возвращается. */
exports.yardAdminRouter.post('/orders/delete', async (req, res) => {
    const parsed = idsSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const ids = parsed.data.ids;
        const [, , orders] = await prisma_1.prisma.$transaction([
            prisma_1.prisma.yardMessage.deleteMany({ where: { orderId: { in: ids } } }),
            prisma_1.prisma.yardOrderItem.deleteMany({ where: { orderId: { in: ids } } }),
            prisma_1.prisma.yardOrder.deleteMany({ where: { id: { in: ids } } }),
        ]);
        res.json({ deleted: orders.count });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /orders/delete упал');
        res.status(500).json({ error: 'Не удалось удалить заказы', details: String(err?.message ?? err) });
    }
});
const renameShopSchema = zod_1.z.object({ name: zod_1.z.string().trim().min(1).max(100) });
/** Открыть магазин, поправить название и сохранить. Больше ничего в магазине эта правка не меняет. */
exports.yardAdminRouter.post('/shops/:id/rename', async (req, res) => {
    const parsed = renameShopSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Название не может быть пустым', details: parsed.error.flatten() });
    try {
        const shop = await prisma_1.prisma.yardShop.update({ where: { id: req.params.id }, data: { name: parsed.data.name } });
        res.json(shop);
    }
    catch (err) {
        if (err?.code === 'P2025')
            return res.status(404).json({ error: 'Магазин не найден' });
        logger_1.logger.error({ err }, '[Yard Admin] POST /shops/:id/rename упал');
        res.status(500).json({ error: 'Не удалось переименовать магазин', details: String(err?.message ?? err) });
    }
});
/** Оборот двора — отдельно от юнит-экономики APP: комиссия 0, налог не считаем. */
exports.yardAdminRouter.get('/turnover', async (_req, res) => {
    try {
        const paidStatuses = ['paid', 'accepted', 'at_door', 'done'];
        const orders = await prisma_1.prisma.yardOrder.findMany({ where: { status: { in: paidStatuses } }, select: { total: true } });
        const total = orders.reduce((sum, o) => sum + o.total, 0);
        res.json({ turnover: total, orderCount: orders.length, commission: 0 });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] GET /turnover упал');
        res.status(500).json({ error: 'Не удалось посчитать оборот двора', details: String(err?.message ?? err) });
    }
});
const paymentSchema = zod_1.z.object({ ok: zod_1.z.boolean() });
exports.yardAdminRouter.post('/orders/:id/payment', async (req, res) => {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const order = await (0, yard_service_1.yardApplyPayment)(req.params.id, parsed.data.ok);
        res.json(order);
    }
    catch (err) {
        if (err instanceof yard_service_1.YardTransitionError)
            return res.status(err.status).json({ error: err.message });
        logger_1.logger.error({ err }, '[Yard Admin] POST /orders/:id/payment упал');
        res.status(500).json({ error: 'Не удалось отметить оплату', details: String(err?.message ?? err) });
    }
});
exports.yardAdminRouter.post('/orders/:id/accept', async (req, res) => {
    try {
        const order = await (0, yard_service_1.yardApplyAccept)(req.params.id);
        res.json(order);
    }
    catch (err) {
        if (err instanceof yard_service_1.YardTransitionError)
            return res.status(err.status).json({ error: err.message });
        logger_1.logger.error({ err }, '[Yard Admin] POST /orders/:id/accept упал');
        res.status(500).json({ error: 'Не удалось принять заказ', details: String(err?.message ?? err) });
    }
});
const closeSchema = zod_1.z.object({ status: zod_1.z.enum(['done', 'not_picked', 'out_of_stock']) });
exports.yardAdminRouter.post('/orders/:id/close', async (req, res) => {
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const order = await (0, yard_service_1.yardApplyClose)(req.params.id, parsed.data.status);
        res.json(order);
    }
    catch (err) {
        if (err instanceof yard_service_1.YardTransitionError)
            return res.status(err.status).json({ error: err.message });
        logger_1.logger.error({ err }, '[Yard Admin] POST /orders/:id/close упал');
        res.status(500).json({ error: 'Не удалось закрыть заказ', details: String(err?.message ?? err) });
    }
});
// =====================================================================
// Видео-инструкция для покупателей (одна на весь сервер, YardSettings "main").
// Читает приложение через GET /api/shop/yard/instruction.
// =====================================================================
const instructionSchema = zod_1.z.object({
    videoUrl: zod_1.z
        .string()
        .trim()
        .max(2000)
        .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Ссылка должна начинаться с http:// или https://')
        .nullable(),
});
/** Текущее значение — чтобы админка показала сохранённую ссылку. */
exports.yardAdminRouter.get('/instruction', async (_req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const row = await prisma_1.prisma.yardSettings.findUnique({ where: { id: 'main' } });
        res.json({ videoUrl: row?.instructionUrl ?? null });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] GET /instruction упал');
        res.status(500).json({ error: 'Не удалось получить видео-инструкцию', details: String(err?.message ?? err) });
    }
});
/** Тело { videoUrl: string | null }; пустая строка или null очищают. */
exports.yardAdminRouter.post('/instruction', async (req, res) => {
    const parsed = instructionSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    const value = parsed.data.videoUrl === null || parsed.data.videoUrl === '' ? null : parsed.data.videoUrl;
    try {
        const row = await prisma_1.prisma.yardSettings.upsert({
            where: { id: 'main' },
            update: { instructionUrl: value },
            create: { id: 'main', instructionUrl: value },
        });
        res.json({ videoUrl: row.instructionUrl ?? null });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard Admin] POST /instruction упал');
        res.status(500).json({ error: 'Не удалось сохранить видео-инструкцию', details: String(err?.message ?? err) });
    }
});
// Рассылка push всем: ВСЕ токены из базы одним пакетом (параллельно, Expo и FCM),
// а не по одному устройству подряд — иначе serverless-функция не успевала дойти до остальных.
exports.yardAdminRouter.post('/push/broadcast', async (req, res) => {
    const { title, body } = req.body ?? {};
    if (!title || !body)
        return res.status(400).json({ error: 'Нужны title и body' });
    try {
        const all = await prisma_1.prisma.shopCustomerPushToken.findMany({ select: { token: true } });
        const tokens = all.map((t) => t.token);
        if (!tokens.length)
            return res.status(404).json({ error: 'Нет получателей с зарегистрированным токеном' });
        const r = await (0, pushBroadcast_service_1.sendBroadcast)({ title: String(title), body: String(body), tokens });
        res.json({ ...r, ok: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Не удалось отправить', details: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=yardAdmin.routes.js.map