"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveAdminRouter = exports.liveRouter = void 0;
const express_1 = __importStar(require("express"));
const functions_1 = require("@vercel/functions");
const zod_1 = require("zod");
const env_1 = require("../config/env");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const shop_routes_1 = require("./shop.routes");
const mediaStorage_service_1 = require("../services/mediaStorage.service");
const live_service_1 = require("../services/live.service");
const shopCategories_1 = require("../config/shopCategories");
/**
 * My Market Live.
 * Приложение (x-app-key): /api/shop/live/... — лента шортс, эфиры, чат; /api/shop/live/creator/... — кабинет креатора.
 * Админка (Basic): /api/shop-admin/live/... — проверка видео, эфиры.
 */
exports.liveRouter = (0, express_1.Router)();
exports.liveAdminRouter = (0, express_1.Router)();
exports.liveRouter.use((req, res, next) => {
    if (!env_1.env.shopAppKey)
        return res.status(503).json({ error: 'SHOP_APP_KEY не настроен' });
    if (req.header('x-app-key') !== env_1.env.shopAppKey)
        return res.status(401).json({ error: 'Неверный x-app-key' });
    next();
});
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_VIDEO_BYTES / CHUNK_BYTES);
const UPLOAD_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'];
// Простой лимит на IP для записи (чат, лайки): 60 в минуту.
const hits = new Map();
function limited(key, max = 60) {
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(key, arr);
    return arr.length > max;
}
const phoneOf = (raw) => (0, shop_routes_1.normalizePhone)(String(raw ?? ''));
// ---------------------------------------------------------------------------
// Покупатели: главная Live, шортс, эфиры, чат
// ---------------------------------------------------------------------------
/** Главная Live: сейчас в эфире, анонсы, свежие шортс. */
exports.liveRouter.get('/home', async (req, res) => {
    try {
        await (0, live_service_1.closeStaleStreams)();
        await (0, live_service_1.resolveReplays)(3).catch(() => undefined);
        const now = Date.now();
        const [live, upcoming, shorts, replays, banners] = await Promise.all([
            prisma_1.prisma.liveStream.findMany({ where: { status: 'live' }, orderBy: { startedAt: 'desc' }, take: 20 }),
            prisma_1.prisma.liveStream.findMany({ where: { status: 'scheduled', scheduledAt: { gte: new Date(now - 60 * 60_000) } }, orderBy: { scheduledAt: 'asc' }, take: 20 }),
            prisma_1.prisma.creatorVideo.findMany({ where: { status: 'published' }, orderBy: { createdAt: 'desc' }, take: 60 }),
            prisma_1.prisma.liveStream.findMany({ where: { status: 'ended', replayUrl: { not: null } }, orderBy: { endedAt: 'desc' }, take: 30 }),
            prisma_1.prisma.liveBanner.findMany({ where: { active: true }, orderBy: { sort: 'asc' }, take: 50 }),
        ]);
        const onAir = live.filter((s) => (0, live_service_1.isOnAir)(s, now));
        const all = [...onAir, ...upcoming, ...shorts, ...replays];
        const [names, cats] = await Promise.all([(0, live_service_1.creatorNames)(all.map((x) => x.creatorId)), (0, live_service_1.activeLiveCategories)()]);
        const bySku = await (0, live_service_1.shopCategoryBySku)(all.flatMap((x) => (0, live_service_1.parseSkus)(x.skus)));
        const withCats = (dto) => ({ ...dto, cats: (0, live_service_1.catsFor)(dto.skus, bySku, cats) });
        res.json({
            categories: cats.map((c) => ({ id: c.id, title: c.title })),
            banners: banners.map(live_service_1.bannerDto),
            live: await Promise.all(onAir.map(async (s) => ({ ...withCats((0, live_service_1.streamDto)(s, names.get(s.creatorId) ?? '')), viewers: await (0, live_service_1.viewersOf)(s.channel) }))),
            upcoming: upcoming.map((s) => withCats((0, live_service_1.streamDto)(s, names.get(s.creatorId) ?? ''))),
            shorts: shorts.map((v) => withCats((0, live_service_1.videoDto)(v, names.get(v.creatorId) ?? ''))),
            replays: replays.map((s) => withCats((0, live_service_1.streamDto)(s, names.get(s.creatorId) ?? ''))),
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] /home упал');
        res.status(500).json({ error: 'Не удалось загрузить Live' });
    }
});
/** Лента шортс: новые сверху, по 10; before — id последнего показанного. device — чтобы знать свои лайки. */
exports.liveRouter.get('/shorts', async (req, res) => {
    try {
        const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 10) || 10));
        let createdBefore;
        if (req.query.before) {
            const last = await prisma_1.prisma.creatorVideo.findUnique({ where: { id: String(req.query.before) } });
            if (last)
                createdBefore = last.createdAt;
        }
        const cat = String(req.query.cat ?? '');
        let rows = await prisma_1.prisma.creatorVideo.findMany({
            where: { status: 'published', ...(createdBefore ? { createdAt: { lt: createdBefore } } : {}) },
            orderBy: { createdAt: 'desc' },
            take: cat ? 200 : limit,
        });
        if (cat) {
            // Лента одной вкладки: только ролики с товарами её разделов.
            const cats = (await (0, live_service_1.activeLiveCategories)()).filter((c) => c.id === cat);
            const bySku = await (0, live_service_1.shopCategoryBySku)(rows.flatMap((r) => (0, live_service_1.parseSkus)(r.skus)));
            rows = rows.filter((r) => (0, live_service_1.catsFor)((0, live_service_1.parseSkus)(r.skus), bySku, cats).length > 0).slice(0, limit);
        }
        const device = String(req.query.device ?? '').slice(0, 80);
        const liked = device
            ? new Set((await prisma_1.prisma.creatorVideoLike.findMany({ where: { deviceKey: device, videoId: { in: rows.map((r) => r.id) } } })).map((l) => l.videoId))
            : new Set();
        const names = await (0, live_service_1.creatorNames)(rows.map((r) => r.creatorId));
        res.json({ items: rows.map((v) => (0, live_service_1.videoDto)(v, names.get(v.creatorId) ?? '', liked.has(v.id))), hasMore: rows.length === limit });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] /shorts упал');
        res.status(500).json({ error: 'Не удалось загрузить видео' });
    }
});
exports.liveRouter.post('/shorts/:id/view', async (req, res) => {
    try {
        await prisma_1.prisma.creatorVideo.updateMany({ where: { id: req.params.id, status: 'published' }, data: { views: { increment: 1 } } });
        res.json({ ok: true });
    }
    catch {
        res.json({ ok: false });
    }
});
/** Лайк / снять лайк: { device, like: true|false }. */
exports.liveRouter.post('/shorts/:id/like', async (req, res) => {
    const device = String(req.body?.device ?? '').trim().slice(0, 80);
    if (!device)
        return res.status(400).json({ error: 'Нет устройства' });
    if (limited(`like:${req.ip}`))
        return res.status(429).json({ error: 'Слишком часто' });
    try {
        const video = await prisma_1.prisma.creatorVideo.findUnique({ where: { id: req.params.id } });
        if (!video || video.status !== 'published')
            return res.status(404).json({ error: 'Видео не найдено' });
        const existing = await prisma_1.prisma.creatorVideoLike.findUnique({ where: { videoId_deviceKey: { videoId: video.id, deviceKey: device } } });
        const like = req.body?.like !== false;
        if (like && !existing) {
            await prisma_1.prisma.creatorVideoLike.create({ data: { videoId: video.id, deviceKey: device } });
            await prisma_1.prisma.creatorVideo.update({ where: { id: video.id }, data: { likes: { increment: 1 } } });
        }
        else if (!like && existing) {
            await prisma_1.prisma.creatorVideoLike.delete({ where: { id: existing.id } });
            await prisma_1.prisma.creatorVideo.update({ where: { id: video.id }, data: { likes: { decrement: 1 } } });
        }
        const fresh = await prisma_1.prisma.creatorVideo.findUnique({ where: { id: video.id } });
        res.json({ liked: like, likes: Math.max(0, fresh?.likes ?? 0) });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] like упал');
        res.status(500).json({ error: 'Не удалось' });
    }
});
/** Эфир для зрителя: данные + токен Agora (только смотреть). */
exports.liveRouter.get('/streams/:id', async (req, res) => {
    try {
        const s = await prisma_1.prisma.liveStream.findUnique({ where: { id: req.params.id } });
        if (!s)
            return res.status(404).json({ error: 'Эфир не найден' });
        const names = await (0, live_service_1.creatorNames)([s.creatorId]);
        const dto = (0, live_service_1.streamDto)(s, names.get(s.creatorId) ?? '');
        if (dto.status === 'live')
            dto.viewers = await (0, live_service_1.viewersOf)(s.channel);
        const device = String(req.query.device ?? '').trim().slice(0, 80);
        if (device) {
            const [lk, fl] = await Promise.all([
                prisma_1.prisma.creatorVideoLike.findUnique({ where: { videoId_deviceKey: { videoId: `s:${s.id}`, deviceKey: device } } }),
                prisma_1.prisma.liveFollow.findUnique({ where: { creatorId_deviceKey: { creatorId: s.creatorId, deviceKey: device } } }),
            ]);
            dto.liked = !!lk;
            dto.following = !!fl;
        }
        const join = dto.status === 'live' && (0, live_service_1.agoraConfigured)()
            ? { appId: live_service_1.AGORA_APP_ID, channel: s.channel, token: (0, live_service_1.agoraToken)(s.channel, 'audience') }
            : null;
        res.json({ ...dto, join });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] GET stream упал');
        res.status(500).json({ error: 'Не удалось открыть эфир' });
    }
});
/** Открыли повтор — +1 просмотр. */
exports.liveRouter.post('/streams/:id/view', async (req, res) => {
    try {
        await prisma_1.prisma.liveStream.updateMany({ where: { id: req.params.id, replayUrl: { not: null } }, data: { views: { increment: 1 } } });
    }
    catch { /* не важно */ }
    res.json({ ok: true });
});
/** ♥ эфира/повтора: { device, like }. Один лайк с устройства (таблица лайков общая с шортс, ключ s:<id>). */
exports.liveRouter.post('/streams/:id/like', async (req, res) => {
    const device = String(req.body?.device ?? '').trim().slice(0, 80);
    if (!device)
        return res.status(400).json({ error: 'Нет устройства' });
    if (limited(`like:${req.ip}`))
        return res.status(429).json({ error: 'Слишком часто' });
    try {
        const s = await prisma_1.prisma.liveStream.findUnique({ where: { id: req.params.id } });
        if (!s)
            return res.status(404).json({ error: 'Эфир не найден' });
        const key = `s:${s.id}`;
        const existing = await prisma_1.prisma.creatorVideoLike.findUnique({ where: { videoId_deviceKey: { videoId: key, deviceKey: device } } });
        const like = req.body?.like !== false;
        if (like && !existing) {
            await prisma_1.prisma.creatorVideoLike.create({ data: { videoId: key, deviceKey: device } });
            await prisma_1.prisma.liveStream.update({ where: { id: s.id }, data: { likes: { increment: 1 } } });
        }
        else if (!like && existing) {
            await prisma_1.prisma.creatorVideoLike.delete({ where: { id: existing.id } });
            await prisma_1.prisma.liveStream.update({ where: { id: s.id }, data: { likes: { decrement: 1 } } });
        }
        const fresh = await prisma_1.prisma.liveStream.findUnique({ where: { id: s.id } });
        res.json({ liked: like, likes: Math.max(0, fresh?.likes ?? 0) });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] stream like упал');
        res.status(500).json({ error: 'Не удалось' });
    }
});
/** 🔔 «Сообщить о следующем эфире» этого креатора: { device, follow, pushToken?, phone? }. */
exports.liveRouter.post('/streams/:id/follow', async (req, res) => {
    const device = String(req.body?.device ?? '').trim().slice(0, 80);
    if (!device)
        return res.status(400).json({ error: 'Нет устройства' });
    if (limited(`follow:${req.ip}`))
        return res.status(429).json({ error: 'Слишком часто' });
    try {
        const s = await prisma_1.prisma.liveStream.findUnique({ where: { id: req.params.id } });
        if (!s)
            return res.status(404).json({ error: 'Эфир не найден' });
        const follow = req.body?.follow !== false;
        const key = { creatorId_deviceKey: { creatorId: s.creatorId, deviceKey: device } };
        const existing = await prisma_1.prisma.liveFollow.findUnique({ where: key });
        const pushToken = String(req.body?.pushToken ?? '').trim().slice(0, 400) || null;
        const phone = phoneOf(req.body?.phone);
        if (follow) {
            if (existing)
                await prisma_1.prisma.liveFollow.update({ where: { id: existing.id }, data: { pushToken: pushToken ?? existing.pushToken, phone: phone ?? existing.phone } });
            else
                await prisma_1.prisma.liveFollow.create({ data: { creatorId: s.creatorId, deviceKey: device, pushToken, phone } });
        }
        else if (existing)
            await prisma_1.prisma.liveFollow.delete({ where: { id: existing.id } });
        res.json({ following: follow });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] follow упал');
        res.status(500).json({ error: 'Не удалось' });
    }
});
/** Чат эфира: новые сообщения после after. */
exports.liveRouter.get('/streams/:id/chat', async (req, res) => {
    try {
        const after = Math.max(0, Number(req.query.after ?? 0) || 0);
        const rows = await prisma_1.prisma.liveChatMessage.findMany({ where: { streamId: req.params.id, id: { gt: after } }, orderBy: { id: 'asc' }, take: 100 });
        const s = await prisma_1.prisma.liveStream.findUnique({ where: { id: req.params.id } });
        res.json({ status: s ? (0, live_service_1.streamDto)(s, '').status : 'ended', messages: rows.map((m) => ({ id: m.id, name: m.name, text: m.text, fromHost: m.fromHost })) });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] chat GET упал');
        res.status(500).json({ error: 'Ошибка' });
    }
});
const PHONE_OR_LINK_RE = /(\+?\d[\d\s()-]{8,}\d)|((https?:\/\/|www\.|t\.me|wa\.me)\S*)|(@[a-z0-9_]{4,})/gi;
/** Сообщение в чат эфира. Телефоны и ссылки вырезаем — покупателей не уводят из приложения. */
exports.liveRouter.post('/streams/:id/chat', async (req, res) => {
    if (limited(`chat:${req.ip}`, 30))
        return res.status(429).json({ error: 'Слишком часто' });
    const text = String(req.body?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(PHONE_OR_LINK_RE, '***');
    const name = String(req.body?.name ?? '').trim().slice(0, 30) || 'Гость';
    if (!text)
        return res.status(400).json({ error: 'Пустое сообщение' });
    try {
        const s = await prisma_1.prisma.liveStream.findUnique({ where: { id: req.params.id } });
        if (!s || !(0, live_service_1.isOnAir)(s))
            return res.status(409).json({ error: 'Эфир завершён' });
        const phone = phoneOf(req.body?.phone);
        const host = phone ? await prisma_1.prisma.creator.findUnique({ where: { phone } }) : null;
        const m = await prisma_1.prisma.liveChatMessage.create({ data: { streamId: s.id, name, text, fromHost: !!host && host.id === s.creatorId } });
        res.json({ id: m.id });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] chat POST упал');
        res.status(500).json({ error: 'Не удалось отправить' });
    }
});
// ---------------------------------------------------------------------------
// Кабинет креатора: загрузка шортс, эфиры
// ---------------------------------------------------------------------------
/** Кусок видео (≤4 МБ) — как в админке, через наш сервер в R2. */
exports.liveRouter.post('/creator/video-chunk', express_1.default.raw({ type: 'application/octet-stream', limit: '4400kb' }), async (req, res) => {
    const uploadId = String(req.query.uploadId ?? '');
    const index = Number(req.query.index);
    if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS)
        return res.status(400).json({ error: 'Неверный кусок загрузки' });
    const phone = phoneOf(req.query.phone);
    if (!phone || !(await (0, live_service_1.activeCreatorByPhone)(phone)))
        return res.status(403).json({ error: 'Загружать видео могут только креаторы' });
    if (!(0, mediaStorage_service_1.isR2Configured)())
        return res.status(501).json({ error: 'Хранилище видео не настроено' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length)
        return res.status(400).json({ error: 'Пустой кусок' });
    try {
        await (0, mediaStorage_service_1.r2PutChunk)(`live-${uploadId}`, index, body);
        res.json({ ok: true, index });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] кусок видео не сохранился');
        res.status(500).json({ error: 'Не удалось сохранить часть видео' });
    }
});
const videoSchema = zod_1.z.object({
    phone: zod_1.z.string(),
    uploadId: zod_1.z.string().regex(UPLOAD_ID_RE),
    total: zod_1.z.number().int().min(1).max(MAX_CHUNKS),
    filename: zod_1.z.string().min(1).max(200),
    contentType: zod_1.z.string(),
    title: zod_1.z.string().trim().min(1).max(120),
    skus: zod_1.z.array(zod_1.z.string()).min(1).max(10),
});
/** Собрать загруженное видео и создать шортс. Новичкам — на проверку, проверенным — сразу в ленту. */
exports.liveRouter.post('/creator/videos', async (req, res) => {
    const parsed = videoSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Добавьте название и хотя бы один товар', details: parsed.error.flatten() });
    const d = parsed.data;
    const phone = phoneOf(d.phone);
    const creator = phone ? await (0, live_service_1.activeCreatorByPhone)(phone) : null;
    if (!creator)
        return res.status(403).json({ error: 'Загружать видео могут только креаторы' });
    const contentType = VIDEO_TYPES.includes(d.contentType) ? d.contentType : 'video/mp4';
    try {
        const r = await (0, mediaStorage_service_1.r2CompleteChunks)(`live-${d.uploadId}`, d.total, d.filename, contentType, MAX_VIDEO_BYTES);
        const video = await prisma_1.prisma.creatorVideo.create({
            data: { creatorId: creator.id, title: d.title, videoUrl: r.url, skus: JSON.stringify((0, live_service_1.cleanSkus)(d.skus)), status: creator.autoPublish ? 'published' : 'pending' },
        });
        res.status(201).json((0, live_service_1.videoDto)(video, creator.name));
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] видео не собралось');
        res.status(500).json({ error: err instanceof mediaStorage_service_1.StorageUnavailableError ? err.message : 'Не удалось сохранить видео' });
    }
});
/** Мои видео и эфиры. */
exports.liveRouter.get('/creator/mine', async (req, res) => {
    const phone = phoneOf(req.query.phone);
    const creator = phone ? await (0, live_service_1.activeCreatorByPhone)(phone) : null;
    if (!creator)
        return res.status(403).json({ error: 'Только для креаторов' });
    try {
        await (0, live_service_1.closeStaleStreams)();
        const [videos, streams] = await Promise.all([
            prisma_1.prisma.creatorVideo.findMany({ where: { creatorId: creator.id, status: { not: 'deleted' } }, orderBy: { createdAt: 'desc' }, take: 50 }),
            prisma_1.prisma.liveStream.findMany({ where: { creatorId: creator.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
        ]);
        res.json({
            videos: videos.map((v) => (0, live_service_1.videoDto)(v, creator.name)),
            streams: streams.map((s) => (0, live_service_1.streamDto)(s, creator.name)),
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] /creator/mine упал');
        res.status(500).json({ error: 'Ошибка' });
    }
});
exports.liveRouter.delete('/creator/videos/:id', async (req, res) => {
    const phone = phoneOf(req.query.phone);
    const creator = phone ? await (0, live_service_1.activeCreatorByPhone)(phone) : null;
    if (!creator)
        return res.status(403).json({ error: 'Только для креаторов' });
    const r = await prisma_1.prisma.creatorVideo.updateMany({ where: { id: req.params.id, creatorId: creator.id }, data: { status: 'deleted' } });
    if (!r.count)
        return res.status(404).json({ error: 'Видео не найдено' });
    res.json({ ok: true });
});
const streamSchema = zod_1.z.object({
    phone: zod_1.z.string(),
    title: zod_1.z.string().trim().min(1).max(120),
    skus: zod_1.z.array(zod_1.z.string()).min(1).max(10),
    scheduledAt: zod_1.z.string().datetime().optional(),
});
/** Анонс эфира на будущее время (попадает во вкладку «Анонсы»). */
exports.liveRouter.post('/creator/streams/schedule', async (req, res) => {
    const parsed = streamSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.scheduledAt)
        return res.status(400).json({ error: 'Укажите название, дату и товары' });
    const creator = await (0, live_service_1.activeCreatorByPhone)(phoneOf(parsed.data.phone) ?? '');
    if (!creator)
        return res.status(403).json({ error: 'Только для креаторов' });
    const at = new Date(parsed.data.scheduledAt);
    if (at.getTime() < Date.now() - 5 * 60_000)
        return res.status(400).json({ error: 'Время эфира уже прошло' });
    const s = await prisma_1.prisma.liveStream.create({
        data: { creatorId: creator.id, title: parsed.data.title, channel: (0, live_service_1.newChannel)(), status: 'scheduled', skus: JSON.stringify((0, live_service_1.cleanSkus)(parsed.data.skus)), scheduledAt: at },
    });
    res.status(201).json((0, live_service_1.streamDto)(s, creator.name));
});
/**
 * Начать эфир: новый или запланированный (streamId). Отдаёт токен ведущего Agora.
 * Пока идёт эфир, приложение раз в ~20 секунд зовёт /beat — иначе эфир закроется сам.
 */
exports.liveRouter.post('/creator/streams/start', async (req, res) => {
    const creator = await (0, live_service_1.activeCreatorByPhone)(phoneOf(req.body?.phone) ?? '');
    if (!creator)
        return res.status(403).json({ error: 'Только для креаторов' });
    if (!(0, live_service_1.agoraConfigured)())
        return res.status(503).json({ error: 'Эфиры ещё не настроены (нет ключа Agora)' });
    try {
        await (0, live_service_1.closeStaleStreams)();
        const now = new Date();
        let s;
        let wasLive = false;
        if (req.body?.streamId) {
            s = await prisma_1.prisma.liveStream.findUnique({ where: { id: String(req.body.streamId) } });
            if (!s || s.creatorId !== creator.id)
                return res.status(404).json({ error: 'Эфир не найден' });
            if (s.status === 'ended')
                return res.status(409).json({ error: 'Этот эфир уже завершён' });
            wasLive = s.status === 'live';
            s = await prisma_1.prisma.liveStream.update({ where: { id: s.id }, data: { status: 'live', startedAt: s.startedAt ?? now, lastBeatAt: now } });
        }
        else {
            const parsed = streamSchema.safeParse(req.body);
            if (!parsed.success)
                return res.status(400).json({ error: 'Укажите название и хотя бы один товар' });
            // Один эфир за раз: прошлый «висящий» закрываем.
            const prev = await prisma_1.prisma.liveStream.findMany({ where: { creatorId: creator.id, status: 'live' } });
            for (const p of prev) {
                await prisma_1.prisma.liveStream.update({ where: { id: p.id }, data: { status: 'ended', endedAt: now } });
                await (0, live_service_1.stopRecording)(p);
            }
            s = await prisma_1.prisma.liveStream.create({
                data: { creatorId: creator.id, title: parsed.data.title, channel: (0, live_service_1.newChannel)(), status: 'live', skus: JSON.stringify((0, live_service_1.cleanSkus)(parsed.data.skus)), startedAt: now, lastBeatAt: now },
            });
        }
        // Запись повтора — в фоне, чтобы не задерживать старт эфира.
        if (s.status === 'live' && s.recState !== 'recording')
            (0, functions_1.waitUntil)((0, live_service_1.startRecording)(s).catch(() => undefined));
        // 🔔 Подписчикам креатора — пуш «эфир начался» (только при настоящем старте, не при повторном входе).
        if (!wasLive)
            (0, functions_1.waitUntil)((0, live_service_1.notifyFollowers)(s, creator.name).catch(() => 0));
        res.json({ ...(0, live_service_1.streamDto)(s, creator.name), join: { appId: live_service_1.AGORA_APP_ID, channel: s.channel, token: (0, live_service_1.agoraToken)(s.channel, 'host') } });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] start упал');
        res.status(500).json({ error: 'Не удалось начать эфир' });
    }
});
exports.liveRouter.post('/creator/streams/:id/beat', async (req, res) => {
    const creator = await (0, live_service_1.activeCreatorByPhone)(phoneOf(req.body?.phone) ?? '');
    if (!creator)
        return res.status(403).json({ error: 'Только для креаторов' });
    const s = await prisma_1.prisma.liveStream.findUnique({ where: { id: req.params.id } });
    const viewers = s ? await (0, live_service_1.viewersOf)(s.channel) : 0;
    if (!s || s.creatorId !== creator.id)
        return res.status(404).json({ error: 'Эфир не найден' });
    if (s.status !== 'live')
        return res.status(409).json({ error: 'Эфир завершён' });
    await prisma_1.prisma.liveStream.update({ where: { id: s.id }, data: { lastBeatAt: new Date(), peakViewers: Math.max(s.peakViewers ?? 0, viewers) } });
    res.json({ ok: true, viewers });
});
exports.liveRouter.post('/creator/streams/:id/stop', async (req, res) => {
    const creator = await (0, live_service_1.activeCreatorByPhone)(phoneOf(req.body?.phone) ?? '');
    if (!creator)
        return res.status(403).json({ error: 'Только для креаторов' });
    const r = await prisma_1.prisma.liveStream.updateMany({ where: { id: req.params.id, creatorId: creator.id, status: { in: ['live', 'scheduled'] } }, data: { status: 'ended', endedAt: new Date() } });
    const s = await prisma_1.prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (s)
        await (0, live_service_1.stopRecording)(s);
    res.json({ ok: true, stopped: r.count });
});
// ---------------------------------------------------------------------------
// Админка
// ---------------------------------------------------------------------------
exports.liveAdminRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
exports.liveAdminRouter.get('/videos', async (req, res) => {
    const status = ['pending', 'published', 'hidden'].includes(String(req.query.status)) ? String(req.query.status) : 'pending';
    const rows = await prisma_1.prisma.creatorVideo.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 300 });
    const names = await (0, live_service_1.creatorNames)(rows.map((r) => r.creatorId));
    res.json(rows.map((v) => (0, live_service_1.videoDto)(v, names.get(v.creatorId) ?? '')));
});
exports.liveAdminRouter.post('/videos/:id/status', async (req, res) => {
    const status = String(req.body?.status ?? '');
    if (!['published', 'hidden', 'pending'].includes(status))
        return res.status(400).json({ error: 'Неверный статус' });
    const r = await prisma_1.prisma.creatorVideo.updateMany({ where: { id: req.params.id }, data: { status } });
    if (!r.count)
        return res.status(404).json({ error: 'Видео не найдено' });
    res.json({ ok: true, status });
});
exports.liveAdminRouter.get('/streams', async (_req, res) => {
    await (0, live_service_1.closeStaleStreams)();
    const rows = await prisma_1.prisma.liveStream.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const names = await (0, live_service_1.creatorNames)(rows.map((r) => r.creatorId));
    res.json(rows.map((s) => ({ ...(0, live_service_1.streamDto)(s, names.get(s.creatorId) ?? ''), peakViewers: s.peakViewers })));
});
/** Остановить эфир из админки (нарушение правил). */
exports.liveAdminRouter.post('/streams/:id/stop', async (req, res) => {
    const r = await prisma_1.prisma.liveStream.updateMany({ where: { id: req.params.id, status: { in: ['live', 'scheduled'] } }, data: { status: 'ended', endedAt: new Date() } });
    const s = await prisma_1.prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (s)
        await (0, live_service_1.stopRecording)(s);
    res.json({ ok: true, stopped: r.count });
});
// ---- Вкладки-категории Live ----
const liveCatSchema = zod_1.z.object({
    title: zod_1.z.string().trim().min(1).max(40),
    categories: zod_1.z.array(zod_1.z.string()).min(1).max(30),
    sort: zod_1.z.number().int().min(0).max(1000).optional().default(0),
    active: zod_1.z.boolean().optional().default(true),
});
exports.liveAdminRouter.get('/categories', async (_req, res) => {
    const rows = await prisma_1.prisma.liveCategory.findMany({ orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
    res.json({ items: rows.map((r) => ({ ...r, categories: (0, live_service_1.parseSkus)(r.categories) })), shopCategories: shopCategories_1.SHOP_CATEGORIES });
});
exports.liveAdminRouter.post('/categories', async (req, res) => {
    const parsed = liveCatSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Название и хотя бы один раздел каталога' });
    const d = parsed.data;
    const categories = d.categories.filter((c) => shopCategories_1.SHOP_CATEGORIES.includes(c));
    if (!categories.length)
        return res.status(400).json({ error: 'Выберите разделы из каталога' });
    const row = await prisma_1.prisma.liveCategory.create({ data: { title: d.title, categories: JSON.stringify(categories), sort: d.sort, active: d.active } });
    res.status(201).json({ ...row, categories });
});
exports.liveAdminRouter.put('/categories/:id', async (req, res) => {
    const parsed = liveCatSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Название и хотя бы один раздел каталога' });
    const d = parsed.data;
    const categories = d.categories.filter((c) => shopCategories_1.SHOP_CATEGORIES.includes(c));
    if (!categories.length)
        return res.status(400).json({ error: 'Выберите разделы из каталога' });
    const r = await prisma_1.prisma.liveCategory.updateMany({ where: { id: req.params.id }, data: { title: d.title, categories: JSON.stringify(categories), sort: d.sort, active: d.active } });
    if (!r.count)
        return res.status(404).json({ error: 'Вкладка не найдена' });
    res.json({ ok: true });
});
exports.liveAdminRouter.delete('/categories/:id', async (req, res) => {
    const r = await prisma_1.prisma.liveCategory.deleteMany({ where: { id: req.params.id } });
    if (!r.count)
        return res.status(404).json({ error: 'Вкладка не найдена' });
    res.json({ ok: true });
});
// ---- Баннеры Live: карусель сверху главной Live, количество не ограничено ----
const bannerSchema = zod_1.z.object({
    imageUrl: zod_1.z.string().trim().url().max(1000),
    title: zod_1.z.string().trim().max(80).optional().default(''),
    linkType: zod_1.z.enum(['', 'stream', 'sku', 'category']).optional().default(''),
    linkValue: zod_1.z.string().trim().max(200).optional().default(''),
    sort: zod_1.z.coerce.number().int().min(0).max(10000).optional().default(0),
    active: zod_1.z.boolean().optional().default(true),
});
const bannerData = (d) => ({
    imageUrl: d.imageUrl, title: d.title || null, linkType: d.linkValue ? d.linkType : '', linkValue: d.linkType && d.linkValue ? d.linkValue : null, sort: d.sort, active: d.active,
});
exports.liveAdminRouter.get('/banners', async (_req, res) => {
    const rows = await prisma_1.prisma.liveBanner.findMany({ orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
    res.json({ items: rows });
});
exports.liveAdminRouter.post('/banners', async (req, res) => {
    const parsed = bannerSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Нужна картинка баннера' });
    const row = await prisma_1.prisma.liveBanner.create({ data: bannerData(parsed.data) });
    res.status(201).json(row);
});
exports.liveAdminRouter.put('/banners/:id', async (req, res) => {
    const parsed = bannerSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Нужна картинка баннера' });
    const r = await prisma_1.prisma.liveBanner.updateMany({ where: { id: req.params.id }, data: bannerData(parsed.data) });
    if (!r.count)
        return res.status(404).json({ error: 'Баннер не найден' });
    res.json({ ok: true });
});
exports.liveAdminRouter.delete('/banners/:id', async (req, res) => {
    const r = await prisma_1.prisma.liveBanner.deleteMany({ where: { id: req.params.id } });
    if (!r.count)
        return res.status(404).json({ error: 'Баннер не найден' });
    res.json({ ok: true });
});
//# sourceMappingURL=live.routes.js.map