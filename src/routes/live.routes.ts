import express, { Router } from 'express';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { normalizePhone } from './shop.routes';
import { isR2Configured, r2CompleteChunks, r2PutChunk, StorageUnavailableError } from '../services/mediaStorage.service';
import {
  AGORA_APP_ID, activeCreatorByPhone, bannerDto, notifyFollowers, activeLiveCategories, agoraConfigured, agoraToken, catsFor, cleanSkus, closeStaleStreams, creatorNames, isOnAir,
  checkCreatorSkus, deleteReplay, deleteStream, isSeller, newChannel, sellerSkus, parseSkus, purgeExpiredReplays, resolveReplays, shopCategoryBySku, soldBySku, startRecording, stopRecording, streamDto, topBySales, videoDto, viewersOf,
} from '../services/live.service';
import { SHOP_CATEGORIES } from '../config/shopCategories';
import {
  DAILY_FREE_COINS, activeGifts, chatDto, chatEvent, cleanName, coinsLeft, creatorGiftCoins, eventAllowed, giftDto, topGifters,
} from '../services/liveGifts.service';
import { uploadPublicFile } from '../services/mediaStorage.service';
import { creatorPage, listCreators } from '../services/liveCreators.service';
import { agoraMonthUsage, agoraUsageConfigured } from '../services/agoraUsage.service';

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

/** Пачка нажатий ♥ (как в ТикТоке): 1..100 за один запрос, иначе 0 — обычный лайк/снять лайк. */
export function tapsOf(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(100, n);
}

// ---------------------------------------------------------------------------
// Покупатели: главная Live, шортс, эфиры, чат
// ---------------------------------------------------------------------------

/** Главная Live: сейчас в эфире, анонсы, свежие шортс. */
liveRouter.get('/home', async (req, res) => {
  try {
    await closeStaleStreams();
    await resolveReplays(3).catch(() => undefined);
    await purgeExpiredReplays(5).catch(() => undefined); // повторы с вышедшим сроком хранения
    const now = Date.now();
    const [live, upcoming, shorts, replays, banners] = await Promise.all([
      prisma.liveStream.findMany({ where: { status: 'live' }, orderBy: { startedAt: 'desc' }, take: 20 }),
      prisma.liveStream.findMany({ where: { status: 'scheduled', scheduledAt: { gte: new Date(now - 60 * 60_000) } }, orderBy: { scheduledAt: 'asc' }, take: 20 }),
      prisma.creatorVideo.findMany({ where: { status: 'published' }, orderBy: { createdAt: 'desc' }, take: 60 }),
      prisma.liveStream.findMany({ where: { status: 'ended', replayUrl: { not: null } }, orderBy: { endedAt: 'desc' }, take: 30 }),
      prisma.liveBanner.findMany({ where: { active: true }, orderBy: { sort: 'asc' }, take: 50 }),
    ]);
    const onAir = live.filter((s: any) => isOnAir(s, now));
    const all = [...onAir, ...upcoming, ...shorts, ...replays];
    const [names, cats] = await Promise.all([creatorNames(all.map((x: any) => x.creatorId)), activeLiveCategories()]);
    const bySku = await shopCategoryBySku(all.flatMap((x: any) => parseSkus(x.skus)));
    const withCats = (dto: any) => ({ ...dto, cats: catsFor(dto.skus, bySku, cats) });
    const device = String(req.query.device ?? '').trim().slice(0, 80);
    const [sold, reminded] = await Promise.all([
      soldBySku(7, now).catch(() => new Map<string, number>()),
      device && upcoming.length
        ? prisma.liveReminder.findMany({ where: { deviceKey: device, streamId: { in: upcoming.map((u: any) => u.id) } }, select: { streamId: true } })
        : Promise.resolve([] as Array<{ streamId: string }>),
    ]);
    const top = topBySales(
      [...onAir, ...replays].map((s: any) => ({ id: s.id, skus: parseSkus(s.skus), views: s.views ?? 0 })),
      shorts.map((v: any) => ({ id: v.id, skus: parseSkus(v.skus), views: v.views ?? 0 })),
      sold,
    );
    res.json({
      categories: cats.map((c) => ({ id: c.id, title: c.title, sections: c.categories })),
      top,
      reminded: (reminded as Array<{ streamId: string }>).map((r) => r.streamId),
      banners: (banners as any[]).map(bannerDto),
      live: await Promise.all(onAir.map(async (s: any) => ({ ...withCats(streamDto(s, names.get(s.creatorId) ?? '')), viewers: await viewersOf(s.channel) }))),
      upcoming: upcoming.map((s: any) => withCats(streamDto(s, names.get(s.creatorId) ?? ''))),
      shorts: shorts.map((v: any) => withCats(videoDto(v, names.get(v.creatorId) ?? ''))),
      replays: replays.map((s: any) => withCats(streamDto(s, names.get(s.creatorId) ?? ''))),
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
    const taps = tapsOf(req.body?.count);
    if (taps) {
      if (!existing) await prisma.creatorVideoLike.create({ data: { videoId: video.id, deviceKey: device } }).catch(() => undefined);
      const fresh = await prisma.creatorVideo.update({ where: { id: video.id }, data: { likes: { increment: taps } } });
      return res.json({ liked: true, likes: fresh.likes });
    }
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
    const [creator, followers, gifts, top] = await Promise.all([
      prisma.creator.findUnique({ where: { id: s.creatorId } }),
      prisma.liveFollow.findMany({ where: { creatorId: s.creatorId }, select: { id: true }, take: 100000 }),
      creatorGiftCoins([s.creatorId]),
      topGifters(s.id),
    ]);
    const dto: any = streamDto(s, creator?.name ?? '');
    dto.creatorAvatar = creator?.avatarUrl ?? '';
    dto.creatorFollowers = followers.length;
    dto.creatorGiftCoins = gifts.get(s.creatorId) ?? 0;
    dto.topGifters = top;
    if (dto.status === 'live') dto.viewers = await viewersOf(s.channel);
    const device = String(req.query.device ?? '').trim().slice(0, 80);
    if (device) {
      const [lk, fl] = await Promise.all([
        prisma.creatorVideoLike.findUnique({ where: { videoId_deviceKey: { videoId: `s:${s.id}`, deviceKey: device } } }),
        prisma.liveFollow.findUnique({ where: { creatorId_deviceKey: { creatorId: s.creatorId, deviceKey: device } } }),
      ]);
      dto.liked = !!lk;
      dto.following = !!fl;
    }
    const join = dto.status === 'live' && agoraConfigured()
      ? { appId: AGORA_APP_ID, channel: s.channel, token: agoraToken(s.channel, 'audience') }
      : null;
    res.json({ ...dto, join });
  } catch (err) {
    logger.error({ err }, '[Live] GET stream упал');
    res.status(500).json({ error: 'Не удалось открыть эфир' });
  }
});

/** Открыли повтор — +1 просмотр. */
liveRouter.post('/streams/:id/view', async (req, res) => {
  try {
    await prisma.liveStream.updateMany({ where: { id: req.params.id, replayUrl: { not: null } }, data: { views: { increment: 1 } } });
  } catch { /* не важно */ }
  res.json({ ok: true });
});

/** ♥ эфира/повтора: { device, like }. Один лайк с устройства (таблица лайков общая с шортс, ключ s:<id>). */
liveRouter.post('/streams/:id/like', async (req, res) => {
  const device = String(req.body?.device ?? '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'Нет устройства' });
  if (limited(`like:${req.ip}`)) return res.status(429).json({ error: 'Слишком часто' });
  try {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Эфир не найден' });
    const key = `s:${s.id}`;
    const existing = await prisma.creatorVideoLike.findUnique({ where: { videoId_deviceKey: { videoId: key, deviceKey: device } } });
    const taps = tapsOf(req.body?.count);
    if (taps) {
      // Как в ТикТоке: сколько раз нажали — столько ♥ и прибавилось.
      if (!existing) await prisma.creatorVideoLike.create({ data: { videoId: key, deviceKey: device } }).catch(() => undefined);
      const fresh = await prisma.liveStream.update({ where: { id: s.id }, data: { likes: { increment: taps } } });
      // В чат: «Аслан отправил(а) лайки (110 шт.)» — не чаще раза в 15 секунд с устройства.
      if (isOnAir(s) && eventAllowed(`like:${s.id}:${device}`, 15_000)) {
        const name = cleanName(req.body?.name);
        await chatEvent(s.id, 'like', name, `отправил(а) лайки (${taps} шт.)`, { likes: taps }).catch(() => undefined);
      }
      return res.json({ liked: true, likes: fresh.likes });
    }
    const like = req.body?.like !== false;
    if (like && !existing) {
      await prisma.creatorVideoLike.create({ data: { videoId: key, deviceKey: device } });
      await prisma.liveStream.update({ where: { id: s.id }, data: { likes: { increment: 1 } } });
    } else if (!like && existing) {
      await prisma.creatorVideoLike.delete({ where: { id: existing.id } });
      await prisma.liveStream.update({ where: { id: s.id }, data: { likes: { decrement: 1 } } });
    }
    const fresh = await prisma.liveStream.findUnique({ where: { id: s.id } });
    res.json({ liked: like, likes: Math.max(0, fresh?.likes ?? 0) });
  } catch (err) {
    logger.error({ err }, '[Live] stream like упал');
    res.status(500).json({ error: 'Не удалось' });
  }
});

/** 🔔 «Сообщить о следующем эфире» этого креатора: { device, follow, pushToken?, phone? }. */
liveRouter.post('/streams/:id/follow', async (req, res) => {
  const device = String(req.body?.device ?? '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'Нет устройства' });
  if (limited(`follow:${req.ip}`)) return res.status(429).json({ error: 'Слишком часто' });
  try {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Эфир не найден' });
    const follow = req.body?.follow !== false;
    const key = { creatorId_deviceKey: { creatorId: s.creatorId, deviceKey: device } };
    const existing = await prisma.liveFollow.findUnique({ where: key });
    const pushToken = String(req.body?.pushToken ?? '').trim().slice(0, 400) || null;
    const phone = phoneOf(req.body?.phone);
    if (follow) {
      if (existing) await prisma.liveFollow.update({ where: { id: existing.id }, data: { pushToken: pushToken ?? existing.pushToken, phone: phone ?? existing.phone } });
      else await prisma.liveFollow.create({ data: { creatorId: s.creatorId, deviceKey: device, pushToken, phone } });
    } else if (existing) await prisma.liveFollow.delete({ where: { id: existing.id } });
    res.json({ following: follow });
  } catch (err) {
    logger.error({ err }, '[Live] follow упал');
    res.status(500).json({ error: 'Не удалось' });
  }
});

/** 🔔 «Напомнить» у анонса: { device, remind, pushToken?, phone? } — пуш, когда этот эфир начнётся. */
liveRouter.post('/streams/:id/remind', async (req, res) => {
  const device = String(req.body?.device ?? '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'Нет устройства' });
  if (limited(`remind:${req.ip}`)) return res.status(429).json({ error: 'Слишком часто' });
  try {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Эфир не найден' });
    const remind = req.body?.remind !== false;
    const key = { streamId_deviceKey: { streamId: s.id, deviceKey: device } };
    const existing = await prisma.liveReminder.findUnique({ where: key });
    const pushToken = String(req.body?.pushToken ?? '').trim().slice(0, 400) || null;
    const phone = phoneOf(req.body?.phone);
    if (remind) {
      if (existing) await prisma.liveReminder.update({ where: { id: existing.id }, data: { pushToken: pushToken ?? existing.pushToken, phone: phone ?? existing.phone } });
      else await prisma.liveReminder.create({ data: { streamId: s.id, deviceKey: device, pushToken, phone } });
    } else if (existing) await prisma.liveReminder.delete({ where: { id: existing.id } });
    res.json({ reminded: remind });
  } catch (err) {
    logger.error({ err }, '[Live] remind упал');
    res.status(500).json({ error: 'Не удалось' });
  }
});

// ---- Креаторы: топ для поиска, страница креатора, подписка (как у Coupang Live) ----

/** Топ креаторов: фото, имя, раздел, подписчики, ♥, подарки; ?device= — на кого я подписан. */
liveRouter.get('/creators', async (req, res) => {
  try {
    const device = String(req.query.device ?? '').trim().slice(0, 80);
    res.json({ items: await listCreators(device) });
  } catch (err) {
    logger.error({ err }, '[Live] /creators упал');
    res.status(500).json({ error: 'Не удалось загрузить креаторов' });
  }
});

/** Страница креатора: эфиры, повторы, анонсы, шортс, товары. */
liveRouter.get('/creators/:id', async (req, res) => {
  try {
    await closeStaleStreams();
    const device = String(req.query.device ?? '').trim().slice(0, 80);
    const page = await creatorPage(req.params.id, device);
    if (!page) return res.status(404).json({ error: 'Креатор не найден' });
    res.json(page);
  } catch (err) {
    logger.error({ err }, '[Live] /creators/:id упал');
    res.status(500).json({ error: 'Не удалось открыть страницу' });
  }
});

/** Подписка на креатора со страницы/поиска: { device, follow, pushToken?, phone? } — пуш, когда выйдет в эфир. */
liveRouter.post('/creators/:id/follow', async (req, res) => {
  const device = String(req.body?.device ?? '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'Нет устройства' });
  if (limited(`follow:${req.ip}`)) return res.status(429).json({ error: 'Слишком часто' });
  try {
    const c = await prisma.creator.findUnique({ where: { id: req.params.id } });
    if (!c || !c.active) return res.status(404).json({ error: 'Креатор не найден' });
    const follow = req.body?.follow !== false;
    const key = { creatorId_deviceKey: { creatorId: c.id, deviceKey: device } };
    const existing = await prisma.liveFollow.findUnique({ where: key });
    const pushToken = String(req.body?.pushToken ?? '').trim().slice(0, 400) || null;
    const phone = phoneOf(req.body?.phone);
    if (follow) {
      if (existing) await prisma.liveFollow.update({ where: { id: existing.id }, data: { pushToken: pushToken ?? existing.pushToken, phone: phone ?? existing.phone } });
      else await prisma.liveFollow.create({ data: { creatorId: c.id, deviceKey: device, pushToken, phone } });
    } else if (existing) await prisma.liveFollow.delete({ where: { id: existing.id } });
    res.json({ following: follow });
  } catch (err) {
    logger.error({ err }, '[Live] creator follow упал');
    res.status(500).json({ error: 'Не удалось' });
  }
});

// ---- События эфира и подарки (как в ТикТок Live) ----

/** Зритель зашёл: в чате «Аслан теперь с нами». */
liveRouter.post('/streams/:id/join', async (req, res) => {
  const device = String(req.body?.device ?? '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'Нет устройства' });
  try {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || !isOnAir(s)) return res.json({ ok: false });
    if (eventAllowed(`join:${s.id}:${device}`, 10 * 60_000)) await chatEvent(s.id, 'join', cleanName(req.body?.name), 'теперь с нами');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[Live] join упал');
    res.json({ ok: false });
  }
});

/** Поделился эфиром: в чате «Аслан поделился(-ась) трансляцией». */
liveRouter.post('/streams/:id/share', async (req, res) => {
  const device = String(req.body?.device ?? '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'Нет устройства' });
  try {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || !isOnAir(s)) return res.json({ ok: false });
    if (eventAllowed(`share:${s.id}:${device}`, 60_000)) await chatEvent(s.id, 'share', cleanName(req.body?.name), 'поделился(-ась) трансляцией');
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

/** Подарки: список и сколько бесплатных монет осталось сегодня у устройства. */
liveRouter.get('/gifts', async (req, res) => {
  try {
    const device = String(req.query.device ?? '').trim().slice(0, 80);
    const [gifts, left] = await Promise.all([activeGifts(), coinsLeft(device)]);
    res.json({ items: gifts.map(giftDto), coins: left, daily: DAILY_FREE_COINS });
  } catch (err) {
    logger.error({ err }, '[Live] gifts упал');
    res.status(500).json({ error: 'Не удалось загрузить подарки' });
  }
});

/** Отправить подарок креатору эфира: { device, name, giftId, count }. Пока за бесплатные монеты дня. */
liveRouter.post('/streams/:id/gift', async (req, res) => {
  const device = String(req.body?.device ?? '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'Нет устройства' });
  if (limited(`gift:${req.ip}`, 40)) return res.status(429).json({ error: 'Слишком часто' });
  const count = Math.min(99, Math.max(1, Math.floor(Number(req.body?.count ?? 1)) || 1));
  try {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || !isOnAir(s)) return res.status(409).json({ error: 'Подарки можно дарить только во время эфира' });
    const gift = await prisma.liveGift.findUnique({ where: { id: String(req.body?.giftId ?? '') } });
    if (!gift || !gift.active) return res.status(404).json({ error: 'Подарок не найден' });
    const total = gift.coins * count;
    const left = await coinsLeft(device);
    if (total > left) return res.status(402).json({ error: `Не хватает монет: осталось ${left} на сегодня`, coins: left });
    const name = cleanName(req.body?.name);
    await prisma.liveGiftSend.create({ data: { streamId: s.id, creatorId: s.creatorId, giftId: gift.id, deviceKey: device, name, count, coins: total } });
    await chatEvent(s.id, 'gift', name, `отправил(а) Подарок «${gift.title}» ×${count}`, {
      giftId: gift.id, title: gift.title, emoji: gift.emoji, imageUrl: gift.imageUrl ?? '', animUrl: (gift as any).animUrl ?? '', soundUrl: (gift as any).soundUrl ?? '', count, coins: total,
    });
    res.json({ ok: true, coins: left - total });
  } catch (err) {
    logger.error({ err }, '[Live] gift упал');
    res.status(500).json({ error: 'Не удалось отправить подарок' });
  }
});

/** Чат эфира: новые сообщения после after. */
liveRouter.get('/streams/:id/chat', async (req, res) => {
  try {
    const after = Math.max(0, Number(req.query.after ?? 0) || 0);
    const rows = await prisma.liveChatMessage.findMany({ where: { streamId: req.params.id, id: { gt: after } }, orderBy: { id: 'asc' }, take: 100 });
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    res.json({
      status: s ? streamDto(s, '').status : 'ended',
      messages: rows.map(chatDto),
      likes: s?.likes ?? 0, // ♥ под именем ведущей обновляется у всех зрителей
      topGifters: s ? await topGifters(s.id) : [],
    });
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
  const skuErr = await checkCreatorSkus(creator, cleanSkus(d.skus));
  if (skuErr) return res.status(400).json({ error: skuErr });
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
    const [gifts, followers] = await Promise.all([
      creatorGiftCoins([creator.id]),
      prisma.liveFollow.findMany({ where: { creatorId: creator.id }, select: { id: true }, take: 100000 }),
    ]);
    res.json({
      profile: {
        name: creator.name, avatarUrl: (creator as any).avatarUrl ?? '', giftCoins: gifts.get(creator.id) ?? 0, followers: followers.length,
        kind: (creator as any).kind ?? 'creator', companyName: (creator as any).companyName ?? '',
      },
      videos: videos.map((v: any) => videoDto(v, creator.name)),
      streams: streams.map((s: any) => streamDto(s, creator.name)),
    });
  } catch (err) {
    logger.error({ err }, '[Live] /creator/mine упал');
    res.status(500).json({ error: 'Ошибка' });
  }
});

/** Какие товары креатор может взять в эфир: продавец — только свои (skus), креатор — все товары приложения (all). */
liveRouter.get('/creator/products', async (req, res) => {
  const creator = await activeCreatorByPhone(phoneOf(req.query.phone) ?? '');
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  if (!isSeller(creator)) return res.json({ kind: 'creator', all: true, skus: [] });
  res.json({ kind: 'seller', all: false, companyName: (creator as any).companyName ?? '', skus: await sellerSkus(creator.id) });
});

/** Фото креатора (аватар в эфире): тело — картинка (jpeg/png/webp) до 3 МБ, ?phone=. */
liveRouter.post('/creator/avatar', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], limit: '3mb' }), async (req, res) => {
  const phone = phoneOf(req.query.phone);
  const creator = phone ? await activeCreatorByPhone(phone) : null;
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 100) return res.status(400).json({ error: 'Пустое фото' });
  const type = String(req.header('content-type') ?? '');
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  try {
    const { url } = await uploadPublicFile('creators', `${creator.id}-${Date.now()}.${ext}`, body, ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    await prisma.creator.update({ where: { id: creator.id }, data: { avatarUrl: url } });
    res.json({ avatarUrl: url });
  } catch (err) {
    if (err instanceof StorageUnavailableError) return res.status(501).json({ error: 'Хранилище фото не настроено' });
    logger.error({ err }, '[Live] аватар креатора не сохранился');
    res.status(500).json({ error: 'Не удалось сохранить фото' });
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
  const skuErr = await checkCreatorSkus(creator, cleanSkus(parsed.data.skus));
  if (skuErr) return res.status(400).json({ error: skuErr });
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
    let wasLive = false;
    if (req.body?.streamId) {
      s = await prisma.liveStream.findUnique({ where: { id: String(req.body.streamId) } });
      if (!s || s.creatorId !== creator.id) return res.status(404).json({ error: 'Эфир не найден' });
      if (s.status === 'ended') return res.status(409).json({ error: 'Этот эфир уже завершён' });
      wasLive = s.status === 'live';
      s = await prisma.liveStream.update({ where: { id: s.id }, data: { status: 'live', startedAt: s.startedAt ?? now, lastBeatAt: now } });
    } else {
      const parsed = streamSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Укажите название и хотя бы один товар' });
      const skuErr = await checkCreatorSkus(creator, cleanSkus(parsed.data.skus));
      if (skuErr) return res.status(400).json({ error: skuErr });
      // Один эфир за раз: прошлый «висящий» закрываем.
      const prev: any[] = await prisma.liveStream.findMany({ where: { creatorId: creator.id, status: 'live' } });
      for (const p of prev) {
        await prisma.liveStream.update({ where: { id: p.id }, data: { status: 'ended', endedAt: now } });
        await stopRecording(p);
      }
      s = await prisma.liveStream.create({
        data: { creatorId: creator.id, title: parsed.data.title, channel: newChannel(), status: 'live', skus: JSON.stringify(cleanSkus(parsed.data.skus)), startedAt: now, lastBeatAt: now },
      });
    }
    // Запись повтора — в фоне, чтобы не задерживать старт эфира.
    if (s.status === 'live' && s.recState !== 'recording') waitUntil(startRecording(s).catch(() => undefined));
    // 🔔 Подписчикам креатора — пуш «эфир начался» (только при настоящем старте, не при повторном входе).
    if (!wasLive) waitUntil(notifyFollowers(s, creator.name).catch(() => 0));
    res.json({ ...streamDto(s, creator.name), join: { appId: AGORA_APP_ID, channel: s.channel, token: agoraToken(s.channel, 'host') } });
  } catch (err) {
    logger.error({ err }, '[Live] start упал');
    res.status(500).json({ error: 'Не удалось начать эфир' });
  }
});

liveRouter.post('/creator/streams/:id/beat', async (req, res) => {
  const creator = await activeCreatorByPhone(phoneOf(req.body?.phone) ?? '');
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
  const viewers = s ? await viewersOf(s.channel) : 0;
  if (!s || s.creatorId !== creator.id) return res.status(404).json({ error: 'Эфир не найден' });
  if (s.status !== 'live') return res.status(409).json({ error: 'Эфир завершён' });
  await prisma.liveStream.update({ where: { id: s.id }, data: { lastBeatAt: new Date(), peakViewers: Math.max(s.peakViewers ?? 0, viewers) } });
  res.json({ ok: true, viewers });
});

liveRouter.post('/creator/streams/:id/stop', async (req, res) => {
  const creator = await activeCreatorByPhone(phoneOf(req.body?.phone) ?? '');
  if (!creator) return res.status(403).json({ error: 'Только для креаторов' });
  const r = await prisma.liveStream.updateMany({ where: { id: req.params.id, creatorId: creator.id, status: { in: ['live', 'scheduled'] } }, data: { status: 'ended', endedAt: new Date() } });
  const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
  if (s) await stopRecording(s);
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
  const rows = await prisma.liveStream.findMany({ orderBy: { createdAt: 'desc' }, take: 300 });
  const names = await creatorNames(rows.map((r: any) => r.creatorId));
  await purgeExpiredReplays(10).catch(() => undefined);
  // Вкладки-категории как в приложении — для фильтра в админке.
  const cats = await activeLiveCategories();
  const bySku = await shopCategoryBySku(rows.flatMap((r: any) => parseSkus(r.skus)));
  res.json({
    categories: cats.map((c) => ({ id: c.id, title: c.title })),
    items: rows.map((s: any) => ({
      ...streamDto(s, names.get(s.creatorId) ?? ''), peakViewers: s.peakViewers, replayUntil: s.replayUntil ?? null,
      onAir: s.status === 'live' && isOnAir(s), cats: catsFor(parseSkus(s.skus), bySku, cats),
    })),
  });
});

/** Удалить повтор эфира: файлы записи в R2 (папка live/<id>/) и сам повтор из приложения. */
liveAdminRouter.delete('/streams/:id/replay', async (req, res) => {
  const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
  if (!s) return res.status(404).json({ error: 'Эфир не найден' });
  if (s.status === 'live') return res.status(409).json({ error: 'Эфир ещё идёт — сначала остановите его' });
  try {
    const removed = await deleteReplay(s.id);
    res.json({ ok: true, removed });
  } catch (err) {
    logger.error({ err }, '[Live] удаление повтора упало');
    res.status(500).json({ error: 'Не удалось удалить файлы в R2' });
  }
});

/** Срок хранения повтора: { days: 0 } — навсегда, иначе 1..365 дней с сегодняшнего дня; потом удалится сам. */
liveAdminRouter.patch('/streams/:id/replay', async (req, res) => {
  const days = Math.floor(Number(req.body?.days ?? 0));
  if (!Number.isFinite(days) || days < 0 || days > 365) return res.status(400).json({ error: 'Срок: 0 (навсегда) или от 1 до 365 дней' });
  const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
  if (!s || !s.replayUrl) return res.status(404).json({ error: 'Повтора нет' });
  const replayUntil = days ? new Date(Date.now() + days * 24 * 60 * 60_000) : null;
  await prisma.liveStream.update({ where: { id: s.id }, data: { replayUntil } });
  res.json({ ok: true, replayUntil });
});

/** Удалить эфиры массово: { ids, mode: 'replay' | 'stream' }. replay — только запись; stream — эфир целиком. Идущие пропускаем. */
liveAdminRouter.post('/streams/bulk-delete', async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 300) : [];
  const mode = req.body?.mode === 'replay' ? 'replay' : 'stream';
  if (!ids.length) return res.status(400).json({ error: 'Ничего не выбрано' });
  let done = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      if (mode === 'stream') {
        if (await deleteStream(id)) done++; else skipped++;
      } else {
        const s = await prisma.liveStream.findUnique({ where: { id } });
        if (s && s.replayUrl && s.status !== 'live') { await deleteReplay(id); done++; } else skipped++;
      }
    } catch (err) {
      logger.warn({ err: String((err as any)?.message ?? err) }, '[Live] массовое удаление');
      skipped++;
    }
  }
  res.json({ ok: true, done, skipped });
});

/** Расход минут Agora за месяц и примерная сумма к оплате (?month=YYYY-MM). */
liveAdminRouter.get('/agora-usage', async (req, res) => {
  if (!agoraUsageConfigured()) return res.json({ configured: false });
  try {
    res.json({ configured: true, ...(await agoraMonthUsage(String(req.query.month ?? '') || undefined)) });
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, '[Live] расход Agora');
    res.json({ configured: true, error: String(err?.message ?? err) });
  }
});

/** Остановить эфир из админки (нарушение правил). */
liveAdminRouter.post('/streams/:id/stop', async (req, res) => {
  const r = await prisma.liveStream.updateMany({ where: { id: req.params.id, status: { in: ['live', 'scheduled'] } }, data: { status: 'ended', endedAt: new Date() } });
  const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
  if (s) await stopRecording(s);
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

// ---- Подарки эфира: список, цена в монетах, картинка (если нет — эмодзи) ----
const giftSchema = z.object({
  title: z.string().trim().min(1).max(40),
  emoji: z.string().trim().max(16).optional().default('🎁'),
  imageUrl: z.string().trim().url().max(500).optional().or(z.literal('')).default(''),
  animUrl: z.string().trim().url().max(500).optional().or(z.literal('')).default(''),
  soundUrl: z.string().trim().url().max(500).optional().or(z.literal('')).default(''),
  coins: z.number().int().min(1).max(100000),
  sort: z.number().int().min(0).max(1000).optional().default(0),
  active: z.boolean().optional().default(true),
});

liveAdminRouter.get('/gifts', async (_req, res) => {
  await activeGifts().catch(() => []);
  const rows = await prisma.liveGift.findMany({ orderBy: [{ sort: 'asc' }, { coins: 'asc' }] });
  const sends: Array<{ giftId: string; count: number }> = await prisma.liveGiftSend.findMany({ select: { giftId: true, count: true }, take: 100000 });
  const sent = new Map<string, number>();
  for (const r of sends) sent.set(r.giftId, (sent.get(r.giftId) ?? 0) + r.count);
  res.json({ items: rows.map((g: any) => ({ ...giftDto(g), sent: sent.get(g.id) ?? 0 })), daily: DAILY_FREE_COINS });
});

liveAdminRouter.post('/gifts', async (req, res) => {
  const p = giftSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Название и цена в монетах (от 1)' });
  const d = p.data;
  const row = await prisma.liveGift.create({ data: { title: d.title, emoji: d.emoji || '🎁', imageUrl: d.imageUrl || null, animUrl: d.animUrl || null, soundUrl: d.soundUrl || null, coins: d.coins, sort: d.sort, active: d.active } });
  res.status(201).json(giftDto(row));
});

liveAdminRouter.put('/gifts/:id', async (req, res) => {
  const p = giftSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Название и цена в монетах (от 1)' });
  const d = p.data;
  const r = await prisma.liveGift.updateMany({ where: { id: req.params.id }, data: { title: d.title, emoji: d.emoji || '🎁', imageUrl: d.imageUrl || null, animUrl: d.animUrl || null, soundUrl: d.soundUrl || null, coins: d.coins, sort: d.sort, active: d.active } });
  if (!r.count) return res.status(404).json({ error: 'Подарок не найден' });
  res.json({ ok: true });
});

liveAdminRouter.delete('/gifts/:id', async (req, res) => {
  // Не удаляем, а скрываем — у отправленных подарков остаётся название.
  const r = await prisma.liveGift.updateMany({ where: { id: req.params.id }, data: { active: false } });
  if (!r.count) return res.status(404).json({ error: 'Подарок не найден' });
  res.json({ ok: true });
});

/** Подарки по креаторам: сколько монет получил каждый. */
liveAdminRouter.get('/gifts/creators', async (_req, res) => {
  const creators: any[] = await prisma.creator.findMany({ select: { id: true, name: true, avatarUrl: true }, take: 1000 });
  const coins = await creatorGiftCoins(creators.map((c) => c.id));
  res.json(creators.map((c) => ({ id: c.id, name: c.name, avatarUrl: c.avatarUrl ?? '', coins: coins.get(c.id) ?? 0 })).sort((a, b) => b.coins - a.coins));
});

// ---- Баннеры Live: карусель сверху главной Live, количество не ограничено ----
const bannerSchema = z.object({
  imageUrl: z.string().trim().url().max(1000),
  title: z.string().trim().max(80).optional().default(''),
  linkType: z.enum(['', 'stream', 'sku', 'category']).optional().default(''),
  linkValue: z.string().trim().max(200).optional().default(''),
  sort: z.coerce.number().int().min(0).max(10000).optional().default(0),
  active: z.boolean().optional().default(true),
});
const bannerData = (d: z.infer<typeof bannerSchema>) => ({
  imageUrl: d.imageUrl, title: d.title || null, linkType: d.linkValue ? d.linkType : '', linkValue: d.linkType && d.linkValue ? d.linkValue : null, sort: d.sort, active: d.active,
});

liveAdminRouter.get('/banners', async (_req, res) => {
  const rows = await prisma.liveBanner.findMany({ orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
  res.json({ items: rows });
});

liveAdminRouter.post('/banners', async (req, res) => {
  const parsed = bannerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Нужна картинка баннера' });
  const row = await prisma.liveBanner.create({ data: bannerData(parsed.data) });
  res.status(201).json(row);
});

liveAdminRouter.put('/banners/:id', async (req, res) => {
  const parsed = bannerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Нужна картинка баннера' });
  const r = await prisma.liveBanner.updateMany({ where: { id: req.params.id }, data: bannerData(parsed.data) });
  if (!r.count) return res.status(404).json({ error: 'Баннер не найден' });
  res.json({ ok: true });
});

liveAdminRouter.delete('/banners/:id', async (req, res) => {
  const r = await prisma.liveBanner.deleteMany({ where: { id: req.params.id } });
  if (!r.count) return res.status(404).json({ error: 'Баннер не найден' });
  res.json({ ok: true });
});
