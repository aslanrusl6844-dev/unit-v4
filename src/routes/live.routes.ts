import express, { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { normalizePhone } from './shop.routes';
import { isR2Configured, r2CompleteChunks, r2PutChunk, StorageUnavailableError } from '../services/mediaStorage.service';
import {
  AGORA_APP_ID, activeCreatorByPhone, activeLiveCategories, agoraConfigured, agoraToken, catsFor, cleanSkus, closeStaleStreams, creatorNames, isOnAir,
  newChannel, parseSkus, shopCategoryBySku, streamDto, videoDto,
} from '../services/live.service';
import { SHOP_CATEGORIES } from '../config/shopCategories';

/**
 * My Market Live.
 * Приложение (x-app-key): /api/shop/live/... — лента шортс, эфиры, чат; /api/shop/live/creator/... — кабинет креатора.
 * Админка (Basic): /api/shop-admin/live/... — проверка видео, эфиры.
 */
export const liveRouter = Router();
export const liveAdminRouter = Router();

liveRouter.use((req, res, next) => {
  if (!env.shopAppKey) return res.status(503).json({ error: 'SHOP_APP_KEY не настроен' });
  if (req.header('x-app-key') !== env.shopAppKey) return res.status(401).json({ error: 'Неверный x-app-key' });
  next();
});

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_VIDEO_BYTES / CHUNK_BYTES);
const UPLOAD_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'];

// Простой лимит на IP для записи (чат, лайки): 60 в минуту.
const hits = new Map<string, number[]>();
function limited(key: string, max = 60): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

const phoneOf = (raw: unknown) => normalizePhone(String(raw ?? ''));

// ---------------------------------------------------------------------------
// Покупатели: главная Live, шортс, эфиры, чат
// ---------------------------------------------------------------------------

/** Главная Live: сейчас в эфире, анонсы, свежие шортс. */
liveRouter.get('/home', async (req, res) => {
  try {
    await closeStaleStreams();
    const now = Date.now();
    const [live, upcoming, shorts] = await Promise.all([
      prisma.liveStream.findMany({ where: { status: 'live' }, orderBy: { startedAt: 'desc' }, take: 20 }),
      prisma.liveStream.findMany({ where: { status: 'scheduled', scheduledAt: { gte: new Date(now - 60 * 60_000) } }, orderBy: { scheduledAt: 'asc' }, take: 20 }),
      prisma.creatorVideo.findMany({ where: { status: 'published' }, orderBy: { createdAt: 'desc' }, take: 60 }),
    ]);
    const onAir = live.filter((s: any) => isOnAir(s, now));
    const all = [...onAir, ...upcoming, ...shorts];
    const [names, cats] = await Promise.all([creatorNames(all.map((x: any) => x.creatorId)), activeLiveCategories()]);
    const bySku = await shopCategoryBySku(all.flatMap((x: any) => parseSkus(x.skus)));
    const withCats = (dto: any) => ({ ...dto, cats: catsFor(dto.skus, bySku, cats) });
    res.json({
      categories: cats.map((c) => ({ id: c.id, title: c.title })),
      live: onAir.map((s: any) => withCats(streamDto(s, names.get(s.creatorId) ?? ''))),
      upcoming: upcoming.map((s: any) => withCats(streamDto(s, names.get(s.creatorId) ?? ''))),
      shorts: shorts.map((v: any) => withCats(videoDto(v, names.get(v.creatorId) ?? ''))),
    });
  } catch (err) {
    logger.error({ err }, '[Live] /home упал');
    res.status(500).json({ error: 'Не удалось загрузить Live' });
  }
});

/** Лента шортс: новые сверху, по 10; before — id последнего показанного. device — чтобы знать свои лайки. */
liveRouter.get('/shorts', async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 10) || 10));
    let createdBefore: Date | undefined;
    if (req.query.before) {
      const last = await prisma.creatorVideo.findUnique({ where: { id: String(req.query.before) } });
      if (last) createdBefore = last.createdAt;
    }
    const cat = String(req.query.cat ?? '');
    let rows: any[] = await prisma.creatorVideo.findMany({
      where: { status: 'published', ...(createdBefore ? { createdAt: { lt: createdBefore } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: cat ? 200 : limit,
    });
    if (cat) {
      // Лента одной вкладки: только ролики с товарами её разделов.
      const cats = (await activeLiveCategories()).filter((c) => c.id === cat);
      const bySku = await shopCategoryBySku(rows.flatMap((r) => parseSkus(r.skus)));
      rows = rows.filter((r) => catsFor(parseSkus(r.skus), bySku, cats).length > 0).slice(0, limit);
    }
    const device = String(req.query.device ?? '').slice(0, 80);
    const liked = device
      ? new Set((await prisma.creatorVideoLike.findMany({ where: { deviceKey: device, videoId: { in: rows.map((r: any) => r.id) } } })).map((l: any) => l.videoId))
      : new Set<string>();
    const names = await creatorNames(rows.map((r: any) => r.creatorId));
    res.json({ items: rows.map((v: any) => videoDto(v, names.get(v.creatorId) ?? '', liked.has(v.id))), hasMore: rows.length === limit });
  } catch (err) {
    logger.error({ err }, '[Live] /shorts упал');
    res.status(500).json({ error: 'Не удалось загрузить видео' });
  }
});

liveRouter.post('/shorts/:id/view', async (req, res) => {
  try {
    await prisma.creatorVideo.updateMany({ where: { id: req.params.id, status: 'published' }, data: { views: { increment: 1 } } });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

/** Лайк / снять лайк: { device, like: true|false }. */
liveRouter.post('/shorts/:id/like', async (req, res) => {
  const device = String(req.body?.device ?? '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'Нет устройства' });
  if (limited(`like:${req.ip}`)) return res.status(429).json({ error: 'Слишком часто' });
  try {
    const video = await prisma.creatorVideo.findUnique({ where: { id: req.params.id } });
    if (!video || video.status !== 'published') return res.status(404).json({ error: 'Видео не найдено' });
    const existing = await prisma.creatorVideoLike.findUnique({ where: { videoId_deviceKey: { videoId: video.id, deviceKey: device } } });
    const like = req.body?.like !== false;
    if (like && !existing) {
      await prisma.creatorVideoLike.create({ data: { videoId: video.id, deviceKey: device } });
      await prisma.creatorVideo.update({ where: { id: video.id }, data: { likes: { increment: 1 } } });
    } else if (!like && existing) {
      await prisma.creatorVideoLike.delete({ where: { id: existing.id } });
      await prisma.creatorVideo.update({ where: { id: video.id }, data: { likes: { decrement: 1 } } });
    }
    const fresh = await prisma.creatorVideo.findUnique({ where: { id: video.id } });
    res.json({ liked: like, likes: Math.max(0, fresh?.likes ?? 0) });
  } catch (err) {
    logger.error({ err }, '[Live] like упал');
    res.status(500).json({ error: 'Не удалось' });
  }
});

/** Эфир для зрителя: данные + токен Agora (только смотреть). */
liveRouter.get('/streams/:id', async (req, res) => {
  try {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Эфир не найден' });
    const names = await creatorNames([s.creatorId]);
    const dto = streamDto(s, names.get(s.creatorId) ?? '');
    const join = dto.status === 'live' && agoraConfigured()
      ? { appId: AGORA_APP_ID, channel: s.channel, token: agoraToken(s.channel, 'audience') }
      : null;
    res.json({ ...dto, join });
  } catch (err) {
    logger.error({ err }, '[Live] GET stream упал');
    res.status(500).json({ error: 'Не удалось открыть эфир' });
  }
});

/** Чат эфира: новые сообщения после after. */
liveRouter.get('/streams/:id/chat', async (req, res) => {
  try {
    const after = Math.max(0, Number(req.query.after ?? 0) || 0);
    const rows = await prisma.liveChatMessage.findMany({ where: { streamId: req.params.id, id: { gt: after } }, orderBy: { id: 'asc' }, take: 100 });
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    res.json({ status: s ? streamDto(s, '').status : 'ended', messages: rows.map((m: any) => ({ id: m.id, name: m.name, text: m.text, fromHost: m.fromHost })) });
  } catch (err) {
    logger.error({ err }, '[Live] chat GET упал');
    res.status(500).json({ error: 'Ошибка' });
  }
});

const PHONE_OR_LINK_RE = /(\+?\d[\d\s()-]{8,}\d)|((https?:\/\/|www\.|t\.me|wa\.me)\S*)|(@[a-z0-9_]{4,})/gi;

/** Сообщение в чат эфира. Телефоны и ссылки вырезаем — покупателей не уводят из приложения. */
liveRouter.post('/streams/:id/chat', async (req, res) => {
  if (limited(`chat:${req.ip}`, 30)) return res.status(429).json({ error: 'Слишком часто' });
  const text = String(req.body?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(PHONE_OR_LINK_RE, '***');
  const name = String(req.body?.name ?? '').trim().slice(0, 30) || 'Гость';
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  try {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || !isOnAir(s)) return res.status(409).json({ error: 'Эфир завершён' });
    const phone = phoneOf(req.body?.phone);
    const host = phone ? await prisma.creator.findUnique({ where: { phone } }) : null;
    const m = await prisma.liveChatMessage.create({ data: { streamId: s.id, name, text, fromHost: !!host && host.id === s.creatorId } });
    res.json({ id: m.id });
  } catch (err) {
    logger.error({ err }, '[Live] chat POST упал');
    res.status(500).json({ error: 'Не удалось отправить' });
  }
});

// ---------------------------------------------------------------------------
// Кабинет креатора: загрузка шортс, эфиры
// ---------------------------------------------------------------------------

/** Кусок видео (≤4 МБ) — как в админке, через наш сервер в R2. */
liveRouter.post('/creator/video-chunk', express.raw({ type: 'application/octet-stream', limit: '4400kb' }), async (req, res) => {
  const uploadId = String(req.query.uploadId ?? '');
  const index = Number(req.query.index);
  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) return res.status(400).json({ error: 'Неверный кусок загрузки' });
  const phone = phoneOf(req.query.phone);
  if (!phone || !(await activeCreatorByPhone(phone))) return res.status(403).json({ error: 'Загружать видео могут только креаторы' });
  if (!isR2Configured()) return res.status(501).json({ error: 'Хранилище видео не настроено' });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'Пустой кусок' });
  try {
    await r2PutChunk(`live-${uploadId}`, index, body);
    res.json({ ok: true, index });
  } catch (err: any) {
    logger.error({ err }, '[Live] кусок видео не сохранился');
    res.status(500).json({ error: 'Не удалось сохранить часть видео' });
  }
});

const videoSchema = z.object({
  phone: z.string(),
  uploadId: z.string().regex(UPLOAD_ID_RE),
  total: z.number().int().min(1).max(MAX_CHUNKS),
  filename: z.string().min(1).max(200),
  contentType: z.string(),
  title: z.string().trim().min(1).max(120),
  skus: z.array(z.string()).min(1).max(10),
});

/** Собрать загруженное видео и создать шортс. Новичкам — на проверку, проверенным — сразу в ленту. */
liveRouter.post('/creator/videos', async (req, res) => {
  const parsed = videoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Добавьте название и хотя бы один товар', details: parsed.error.flatten() });
  const d = parsed.data;
  const phone = phoneOf(d.phone);
  const creator = phone ? await activeCreatorByPhone(phone) : null;
  if (!creator) return res.status(403).json({ error: 'Загружать видео могут только креаторы' });
  const contentType = VIDEO_TYPES.includes(d.contentType) ? d.contentType : 'video/mp4';
  try {
    const r = await r2CompleteChunks(`live-${d.uploadId}`, d.total, d.filename, contentType, MAX_VIDEO_BYTES);
    const video = await prisma.creatorVideo.create({
      data: { creatorId: creator.id, title: d.title, videoUrl: r.url, skus: JSON.stringify(cleanSkus(d.skus)), status: creator.autoPublish ? 'published' : 'pending' },
    });
    res.status(201).json(videoDto(video, creator.name));
  } catch (err: any) {
    logger.error({ err }, '[Live] видео не собралось');
    res.status(500).json({ error: err instanceof StorageUnavailableError ? err.message : 'Не удалось сохранить видео' });
  }
});

/** Мои видео и эфиры. */
liveRouter.get('/creator/mine', async (req, res) => {
  const phone = phoneOf(req.query.phone);
  const creator = phone ? await activeCreatorByPhone(phone) : null;
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  try {
    await closeStaleStreams();
    const [videos, streams] = await Promise.all([
      prisma.creatorVideo.findMany({ where: { creatorId: creator.id, status: { not: 'deleted' } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.liveStream.findMany({ where: { creatorId: creator.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    res.json({
      videos: videos.map((v: any) => videoDto(v, creator.name)),
      streams: streams.map((s: any) => streamDto(s, creator.name)),
    });
  } catch (err) {
    logger.error({ err }, '[Live] /creator/mine упал');
    res.status(500).json({ error: 'Ошибка' });
  }
});

liveRouter.delete('/creator/videos/:id', async (req, res) => {
  const phone = phoneOf(req.query.phone);
  const creator = phone ? await activeCreatorByPhone(phone) : null;
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  const r = await prisma.creatorVideo.updateMany({ where: { id: req.params.id, creatorId: creator.id }, data: { status: 'deleted' } });
  if (!r.count) return res.status(404).json({ error: 'Видео не найдено' });
  res.json({ ok: true });
});

const streamSchema = z.object({
  phone: z.string(),
  title: z.string().trim().min(1).max(120),
  skus: z.array(z.string()).min(1).max(10),
  scheduledAt: z.string().datetime().optional(),
});

/** Анонс эфира на будущее время (попадает во вкладку «Анонсы»). */
liveRouter.post('/creator/streams/schedule', async (req, res) => {
  const parsed = streamSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.scheduledAt) return res.status(400).json({ error: 'Укажите название, дату и товары' });
  const creator = await activeCreatorByPhone(phoneOf(parsed.data.phone) ?? '');
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  const at = new Date(parsed.data.scheduledAt);
  if (at.getTime() < Date.now() - 5 * 60_000) return res.status(400).json({ error: 'Время эфира уже прошло' });
  const s = await prisma.liveStream.create({
    data: { creatorId: creator.id, title: parsed.data.title, channel: newChannel(), status: 'scheduled', skus: JSON.stringify(cleanSkus(parsed.data.skus)), scheduledAt: at },
  });
  res.status(201).json(streamDto(s, creator.name));
});

/**
 * Начать эфир: новый или запланированный (streamId). Отдаёт токен ведущего Agora.
 * Пока идёт эфир, приложение раз в ~20 секунд зовёт /beat — иначе эфир закроется сам.
 */
liveRouter.post('/creator/streams/start', async (req, res) => {
  const creator = await activeCreatorByPhone(phoneOf(req.body?.phone) ?? '');
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  if (!agoraConfigured()) return res.status(503).json({ error: 'Эфиры ещё не настроены (нет ключа Agora)' });
  try {
    await closeStaleStreams();
    const now = new Date();
    let s: any;
    if (req.body?.streamId) {
      s = await prisma.liveStream.findUnique({ where: { id: String(req.body.streamId) } });
      if (!s || s.creatorId !== creator.id) return res.status(404).json({ error: 'Эфир не найден' });
      if (s.status === 'ended') return res.status(409).json({ error: 'Этот эфир уже завершён' });
      s = await prisma.liveStream.update({ where: { id: s.id }, data: { status: 'live', startedAt: s.startedAt ?? now, lastBeatAt: now } });
    } else {
      const parsed = streamSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Укажите название и хотя бы один товар' });
      // Один эфир за раз: прошлый «висящий» закрываем.
      await prisma.liveStream.updateMany({ where: { creatorId: creator.id, status: 'live' }, data: { status: 'ended', endedAt: now } });
      s = await prisma.liveStream.create({
        data: { creatorId: creator.id, title: parsed.data.title, channel: newChannel(), status: 'live', skus: JSON.stringify(cleanSkus(parsed.data.skus)), startedAt: now, lastBeatAt: now },
      });
    }
    res.json({ ...streamDto(s, creator.name), join: { appId: AGORA_APP_ID, channel: s.channel, token: agoraToken(s.channel, 'host') } });
  } catch (err) {
    logger.error({ err }, '[Live] start упал');
    res.status(500).json({ error: 'Не удалось начать эфир' });
  }
});

liveRouter.post('/creator/streams/:id/beat', async (req, res) => {
  const creator = await activeCreatorByPhone(phoneOf(req.body?.phone) ?? '');
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  const viewers = Math.max(0, Math.min(1_000_000, Number(req.body?.viewers ?? 0) || 0));
  const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
  if (!s || s.creatorId !== creator.id) return res.status(404).json({ error: 'Эфир не найден' });
  if (s.status !== 'live') return res.status(409).json({ error: 'Эфир завершён' });
  await prisma.liveStream.update({ where: { id: s.id }, data: { lastBeatAt: new Date(), peakViewers: Math.max(s.peakViewers ?? 0, viewers) } });
  res.json({ ok: true });
});

liveRouter.post('/creator/streams/:id/stop', async (req, res) => {
  const creator = await activeCreatorByPhone(phoneOf(req.body?.phone) ?? '');
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  const r = await prisma.liveStream.updateMany({ where: { id: req.params.id, creatorId: creator.id, status: { in: ['live', 'scheduled'] } }, data: { status: 'ended', endedAt: new Date() } });
  res.json({ ok: true, stopped: r.count });
});

// ---------------------------------------------------------------------------
// Админка
// ---------------------------------------------------------------------------

liveAdminRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

liveAdminRouter.get('/videos', async (req, res) => {
  const status = ['pending', 'published', 'hidden'].includes(String(req.query.status)) ? String(req.query.status) : 'pending';
  const rows = await prisma.creatorVideo.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 300 });
  const names = await creatorNames(rows.map((r: any) => r.creatorId));
  res.json(rows.map((v: any) => videoDto(v, names.get(v.creatorId) ?? '')));
});

liveAdminRouter.post('/videos/:id/status', async (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!['published', 'hidden', 'pending'].includes(status)) return res.status(400).json({ error: 'Неверный статус' });
  const r = await prisma.creatorVideo.updateMany({ where: { id: req.params.id }, data: { status } });
  if (!r.count) return res.status(404).json({ error: 'Видео не найдено' });
  res.json({ ok: true, status });
});

liveAdminRouter.get('/streams', async (_req, res) => {
  await closeStaleStreams();
  const rows = await prisma.liveStream.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  const names = await creatorNames(rows.map((r: any) => r.creatorId));
  res.json(rows.map((s: any) => ({ ...streamDto(s, names.get(s.creatorId) ?? ''), peakViewers: s.peakViewers })));
});

/** Остановить эфир из админки (нарушение правил). */
liveAdminRouter.post('/streams/:id/stop', async (req, res) => {
  const r = await prisma.liveStream.updateMany({ where: { id: req.params.id, status: { in: ['live', 'scheduled'] } }, data: { status: 'ended', endedAt: new Date() } });
  res.json({ ok: true, stopped: r.count });
});

// ---- Вкладки-категории Live ----

const liveCatSchema = z.object({
  title: z.string().trim().min(1).max(40),
  categories: z.array(z.string()).min(1).max(30),
  sort: z.number().int().min(0).max(1000).optional().default(0),
  active: z.boolean().optional().default(true),
});

liveAdminRouter.get('/categories', async (_req, res) => {
  const rows = await prisma.liveCategory.findMany({ orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
  res.json({ items: rows.map((r: any) => ({ ...r, categories: parseSkus(r.categories) })), shopCategories: SHOP_CATEGORIES });
});

liveAdminRouter.post('/categories', async (req, res) => {
  const parsed = liveCatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Название и хотя бы один раздел каталога' });
  const d = parsed.data;
  const categories = d.categories.filter((c) => SHOP_CATEGORIES.includes(c));
  if (!categories.length) return res.status(400).json({ error: 'Выберите разделы из каталога' });
  const row = await prisma.liveCategory.create({ data: { title: d.title, categories: JSON.stringify(categories), sort: d.sort, active: d.active } });
  res.status(201).json({ ...row, categories });
});

liveAdminRouter.put('/categories/:id', async (req, res) => {
  const parsed = liveCatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Название и хотя бы один раздел каталога' });
  const d = parsed.data;
  const categories = d.categories.filter((c) => SHOP_CATEGORIES.includes(c));
  if (!categories.length) return res.status(400).json({ error: 'Выберите разделы из каталога' });
  const r = await prisma.liveCategory.updateMany({ where: { id: req.params.id }, data: { title: d.title, categories: JSON.stringify(categories), sort: d.sort, active: d.active } });
  if (!r.count) return res.status(404).json({ error: 'Вкладка не найдена' });
  res.json({ ok: true });
});

liveAdminRouter.delete('/categories/:id', async (req, res) => {
  const r = await prisma.liveCategory.deleteMany({ where: { id: req.params.id } });
  if (!r.count) return res.status(404).json({ error: 'Вкладка не найдена' });
  res.json({ ok: true });
});
