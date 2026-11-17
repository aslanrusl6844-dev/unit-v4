"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.creatorAdminRouter = exports.creatorRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const env_1 = require("../config/env");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const shop_routes_1 = require("./shop.routes");
const creator_service_1 = require("../services/creator.service");
/**
 * Креаторы My Market Live.
 * Приложение (x-app-key): /api/shop/creator/apply, /api/shop/creator/me.
 * Админка (Basic): /api/shop-admin/creators/...
 */
exports.creatorRouter = (0, express_1.Router)();
exports.creatorAdminRouter = (0, express_1.Router)();
exports.creatorRouter.use((req, res, next) => {
    if (!env_1.env.shopAppKey)
        return res.status(503).json({ error: 'SHOP_APP_KEY не настроен' });
    if (req.header('x-app-key') !== env_1.env.shopAppKey)
        return res.status(401).json({ error: 'Неверный x-app-key' });
    next();
});
const str = (max) => zod_1.z.string().trim().max(max).optional().default('');
const answersSchema = zod_1.z.object({
    ageRange: str(20),
    language: str(30),
    socials: str(400),
    followers: str(40),
    experience: str(1000),
    phoneModel: str(80),
    equipment: str(200), // штатив, кольцевая лампа
    stableInternet: str(20),
    hoursPerWeek: str(20),
    timeOfDay: str(60),
    format: str(40), // короткие видео / эфиры / оба
    interests: zod_1.z.array(zod_1.z.string().trim().max(40)).max(12).optional().default([]),
    kids: str(200),
    motivation: str(1000),
}).partial();
const applySchema = zod_1.z.object({
    phone: zod_1.z.string().min(5).max(30),
    name: zod_1.z.string().trim().min(2).max(80),
    city: zod_1.z.string().trim().min(2).max(80),
    answers: answersSchema.optional().default({}),
    trialVideoUrl: zod_1.z.string().trim().url().startsWith('https://').max(600).optional().nullable(),
    consentPersonalData: zod_1.z.literal(true),
    consentRules: zod_1.z.literal(true),
    adult: zod_1.z.literal(true),
});
/** Заявка «Я креатор». Повторная подача, пока заявка на рассмотрении, — обновляет анкету. */
exports.creatorRouter.post('/apply', async (req, res) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Заполните анкету и отметьте согласия', details: parsed.error.flatten() });
    const phone = (0, shop_routes_1.normalizePhone)(parsed.data.phone);
    if (!phone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    const d = parsed.data;
    const data = {
        name: d.name,
        city: d.city,
        answers: JSON.stringify({ ...d.answers, consents: { personalData: true, rules: true, adult: true, at: new Date().toISOString() } }),
        trialVideoUrl: d.trialVideoUrl || null,
    };
    try {
        const existing = await prisma_1.prisma.creatorApplication.findUnique({ where: { phone } });
        if (existing && existing.status !== 'pending')
            return res.json({ status: existing.status });
        const app = existing
            ? await prisma_1.prisma.creatorApplication.update({ where: { phone }, data })
            : await prisma_1.prisma.creatorApplication.create({ data: { ...data, phone, status: 'pending' } });
        res.status(existing ? 200 : 201).json({ status: app.status });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Creator] POST /apply упал');
        res.status(500).json({ error: 'Не удалось отправить заявку' });
    }
});
/** Статус креатора по телефону: none / pending / approved / rejected; у одобренного — код и процент. */
exports.creatorRouter.get('/me', async (req, res) => {
    const phone = (0, shop_routes_1.normalizePhone)(String(req.query.phone ?? ''));
    if (!phone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const app = await prisma_1.prisma.creatorApplication.findUnique({ where: { phone } });
        if (!app)
            return res.json({ status: 'none' });
        if (app.status !== 'approved')
            return res.json({ status: app.status });
        const creator = await prisma_1.prisma.creator.findUnique({ where: { phone } });
        if (!creator || !creator.active)
            return res.json({ status: creator ? 'blocked' : 'pending' });
        res.json({ status: 'approved', creator: { code: creator.code, percent: creator.percent, name: creator.name } });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Creator] GET /me упал');
        res.status(500).json({ error: 'Не удалось получить статус' });
    }
});
// ---------------------------------------------------------------------------
// Админка
// ---------------------------------------------------------------------------
exports.creatorAdminRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
/** Заявки: ?status=pending|approved|rejected (по умолчанию pending). */
exports.creatorAdminRouter.get('/applications', async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(String(req.query.status)) ? String(req.query.status) : 'pending';
    try {
        const rows = await prisma_1.prisma.creatorApplication.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 500 });
        res.json(rows.map((a) => ({ ...a, answers: (0, creator_service_1.parseAnswers)(a.answers) })));
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Creator Admin] GET /applications упал');
        res.status(500).json({ error: 'Не удалось получить заявки' });
    }
});
exports.creatorAdminRouter.post('/applications/:id/approve', async (req, res) => {
    const percent = (0, creator_service_1.normalizePercent)(req.body?.percent ?? creator_service_1.CREATOR_DEFAULT_PERCENT);
    if (percent == null)
        return res.status(400).json({ error: 'Процент — от 1 до 50' });
    try {
        const creator = await (0, creator_service_1.approveApplication)(req.params.id, percent);
        if (!creator)
            return res.status(404).json({ error: 'Заявка не найдена' });
        res.json(creator);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Creator Admin] approve упал');
        res.status(500).json({ error: 'Не удалось одобрить заявку' });
    }
});
exports.creatorAdminRouter.post('/applications/:id/reject', async (req, res) => {
    const reason = String(req.body?.reason ?? '').trim().slice(0, 300) || null;
    try {
        const app = await prisma_1.prisma.creatorApplication.findUnique({ where: { id: req.params.id } });
        if (!app)
            return res.status(404).json({ error: 'Заявка не найдена' });
        const updated = await prisma_1.prisma.creatorApplication.update({ where: { id: app.id }, data: { status: 'rejected', reviewedAt: new Date(), rejectReason: reason } });
        // Одобренного раньше креатора — выключаем.
        await prisma_1.prisma.creator.updateMany({ where: { phone: app.phone }, data: { active: false } });
        res.json(updated);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Creator Admin] reject упал');
        res.status(500).json({ error: 'Не удалось отклонить заявку' });
    }
});
/** Вернуть отклонённую заявку на рассмотрение. */
exports.creatorAdminRouter.post('/applications/:id/reopen', async (req, res) => {
    try {
        const app = await prisma_1.prisma.creatorApplication.findUnique({ where: { id: req.params.id } });
        if (!app)
            return res.status(404).json({ error: 'Заявка не найдена' });
        const updated = await prisma_1.prisma.creatorApplication.update({ where: { id: app.id }, data: { status: 'pending', reviewedAt: null, rejectReason: null } });
        res.json(updated);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Creator Admin] reopen упал');
        res.status(500).json({ error: 'Не удалось вернуть заявку' });
    }
});
/** Одобренные креаторы. */
exports.creatorAdminRouter.get('/', async (_req, res) => {
    try {
        const rows = await prisma_1.prisma.creator.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 });
        res.json(rows);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Creator Admin] GET / упал');
        res.status(500).json({ error: 'Не удалось получить креаторов' });
    }
});
/** Поменять процент или включить/выключить креатора. */
exports.creatorAdminRouter.patch('/:id', async (req, res) => {
    const data = {};
    if (req.body?.percent !== undefined) {
        const percent = (0, creator_service_1.normalizePercent)(req.body.percent);
        if (percent == null)
            return res.status(400).json({ error: 'Процент — от 1 до 50' });
        data.percent = percent;
    }
    if (req.body?.active !== undefined)
        data.active = !!req.body.active;
    if (req.body?.autoPublish !== undefined)
        data.autoPublish = !!req.body.autoPublish;
    if (!Object.keys(data).length)
        return res.status(400).json({ error: 'Нечего менять' });
    try {
        const creator = await prisma_1.prisma.creator.update({ where: { id: req.params.id }, data });
        res.json(creator);
    }
    catch (err) {
        if (err?.code === 'P2025')
            return res.status(404).json({ error: 'Креатор не найден' });
        logger_1.logger.error({ err }, '[Creator Admin] PATCH упал');
        res.status(500).json({ error: 'Не удалось сохранить' });
    }
});
//# sourceMappingURL=creator.routes.js.map