/**
 * My Market Live: шортс креаторов и прямые эфиры (Agora).
 * Видео — в Cloudflare R2, эфир — Agora (токены выдаёт сервер), чат эфира — у нас в базе.
 */
import { randomBytes } from 'crypto';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { isR2Configured, r2ListKeys, r2PublicUrl } from './mediaStorage.service';
import { logger } from '../utils/logger';

/** App ID проекта Agora не секрет (он и так есть в приложении); сертификат — только в переменных Vercel. */
export const AGORA_APP_ID = process.env.AGORA_APP_ID?.trim() || 'eddfb3532542449897a94b234761dbc8';
export const agoraConfigured = () => !!process.env.AGORA_APP_CERTIFICATE?.trim();

/** Эфир без отметки креатора дольше этого — считается завершённым (приложение закрыли, пропала сеть). */
export const LIVE_STALE_MS = 90_000;
export const TOKEN_TTL_S = 4 * 60 * 60;
export const MAX_SKUS = 10;

export function agoraToken(channel: string, role: 'host' | 'audience'): string {
  const cert = process.env.AGORA_APP_CERTIFICATE?.trim();
  if (!cert) throw new Error('AGORA_APP_CERTIFICATE не настроен');
  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID, cert, channel, 0,
    role === 'host' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
    TOKEN_TTL_S, TOKEN_TTL_S,
  );
}

export function newChannel(): string {
  return `mm-${randomBytes(6).toString('hex')}`;
}

export function cleanSkus(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.map((s) => String(s ?? '').trim()).filter((s) => s && s.length <= 60);
  return Array.from(new Set(out)).slice(0, MAX_SKUS);
}

export function parseSkus(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

type StreamRow = { status: string; lastBeatAt?: Date | null; startedAt?: Date | null };

/** Эфир действительно идёт: статус live и креатор недавно отмечался. */
export function isOnAir(s: StreamRow, now = Date.now()): boolean {
  if (s.status !== 'live') return false;
  const beat = s.lastBeatAt ?? s.startedAt;
  return !!beat && now - new Date(beat).getTime() < LIVE_STALE_MS;
}

/** Активный креатор по телефону (или null). */
export async function activeCreatorByPhone(phone: string) {
  const c = await prisma.creator.findUnique({ where: { phone } });
  return c && c.active ? c : null;
}

/** Закрывает «зависшие» эфиры (креатор пропал) — вызывается при чтении списков. Запись тоже останавливаем. */
export async function closeStaleStreams(now = Date.now()): Promise<void> {
  const stale: any[] = await prisma.liveStream.findMany({ where: { status: 'live', lastBeatAt: { lt: new Date(now - LIVE_STALE_MS) } }, take: 20 });
  for (const s of stale) {
    await prisma.liveStream.update({ where: { id: s.id }, data: { status: 'ended', endedAt: new Date(now) } });
    await stopRecording(s);
  }
}

export function videoDto(v: any, creatorName: string, liked = false) {
  return {
    id: v.id, title: v.title, videoUrl: v.videoUrl, skus: parseSkus(v.skus), likes: v.likes, views: v.views,
    status: v.status, creatorName, creatorId: v.creatorId ?? '', liked, createdAt: v.createdAt,
  };
}

export function streamDto(s: any, creatorName: string) {
  return {
    id: s.id, title: s.title, status: isOnAir(s) ? 'live' : s.status === 'live' ? 'ended' : s.status,
    skus: parseSkus(s.skus), scheduledAt: s.scheduledAt, startedAt: s.startedAt, endedAt: s.endedAt, creatorName,
    replayUrl: s.replayUrl ?? null, likes: s.likes ?? 0, views: s.views ?? 0, viewers: 0, creatorId: s.creatorId ?? '',
  };
}

/** Имена креаторов одним запросом. */
export async function creatorNames(ids: string[]): Promise<Map<string, string>> {
  const uniq = Array.from(new Set(ids));
  if (!uniq.length) return new Map();
  const rows: Array<{ id: string; name: string }> = await prisma.creator.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Вкладки-категории Live: эфир/ролик попадает во вкладку по разделу своих товаров.
// ---------------------------------------------------------------------------

export type LiveCat = { id: string; title: string; categories: string[] };

export async function activeLiveCategories(): Promise<LiveCat[]> {
  const rows: any[] = await prisma.liveCategory.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
  return rows.map((r) => ({ id: r.id, title: r.title, categories: parseSkus(r.categories) }));
}

/** Раздел каталога для каждого артикула (артикул витрины или sku). */
export async function shopCategoryBySku(skus: string[]): Promise<Map<string, string>> {
  const uniq = Array.from(new Set(skus.filter(Boolean)));
  if (!uniq.length) return new Map();
  const rows: Array<{ sku: string; shopArticle: string | null; category: string | null }> = await prisma.product.findMany({
    where: { OR: [{ shopArticle: { in: uniq } }, { sku: { in: uniq } }] },
    select: { sku: true, shopArticle: true, category: true },
  });
  const map = new Map<string, string>();
  for (const r of rows) {
    if (!r.category) continue;
    if (r.shopArticle) map.set(r.shopArticle, r.category);
    map.set(r.sku, r.category);
  }
  return map;
}

/** id вкладок, в которые попадает набор товаров. */
export function catsFor(skus: string[], bySku: Map<string, string>, cats: LiveCat[]): string[] {
  const shopCats = new Set(skus.map((s) => bySku.get(s)).filter((c): c is string => !!c));
  return cats.filter((c) => c.categories.some((x) => shopCats.has(x))).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Повторы: облачная запись Agora (смешанная, вертикальная 720×1280) прямо в наш R2.
// Нужны AGORA_CUSTOMER_ID / AGORA_CUSTOMER_SECRET (RESTful API в консоли Agora),
// карта в Agora и включённый Cloud Recording. Без них эфиры работают, просто без записи.
// ---------------------------------------------------------------------------


export const RECORDER_UID = '999';

export function recordingConfigured(): boolean {
  return !!(process.env.AGORA_CUSTOMER_ID?.trim() && process.env.AGORA_CUSTOMER_SECRET?.trim() && agoraConfigured() && isR2Configured());
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...a) => fetch(...a);
/** Для тестов. */
export function setRecordingFetch(f: FetchLike) { fetchImpl = f; }

async function agoraRest(path: string, body: unknown): Promise<any> {
  const auth = Buffer.from(`${process.env.AGORA_CUSTOMER_ID?.trim()}:${process.env.AGORA_CUSTOMER_SECRET?.trim()}`).toString('base64');
  const res = await fetchImpl(`https://api.agora.io/v1/apps/${AGORA_APP_ID}/cloud_recording${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=utf-8', authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Agora запись ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** Папка записи эфира в R2 (Agora разрешает только латиницу и цифры). */
export const replayPrefix = (streamId: string) => ['live', streamId.replace(/[^a-zA-Z0-9]/g, '')];

/** Запустить запись эфира. Ошибка не мешает эфиру — просто не будет повтора. */
export async function startRecording(stream: { id: string; channel: string }): Promise<void> {
  if (!recordingConfigured()) return;
  try {
    const acq = await agoraRest('/acquire', { cname: stream.channel, uid: RECORDER_UID, clientRequest: { resourceExpiredHour: 24, scene: 0 } });
    const resourceId = acq.resourceId as string;
    const st = await agoraRest(`/resourceid/${resourceId}/mode/mix/start`, {
      cname: stream.channel,
      uid: RECORDER_UID,
      clientRequest: {
        token: agoraToken(stream.channel, 'audience'),
        recordingConfig: {
          channelType: 1, // эфир
          streamTypes: 2, // звук и видео
          maxIdleTime: 120, // ведущий пропал на 2 минуты — запись останавливается сама
          transcodingConfig: { width: 720, height: 1280, fps: 24, bitrate: 1500, mixedVideoLayout: 1 },
        },
        recordingFileConfig: { avFileType: ['hls', 'mp4'] },
        storageConfig: {
          vendor: 11, // S3-совместимое хранилище — Cloudflare R2
          region: 0,
          bucket: env.r2.bucket,
          accessKey: env.r2.accessKeyId,
          secretKey: env.r2.secretAccessKey,
          fileNamePrefix: replayPrefix(stream.id),
          extensionParams: { endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com` },
        },
      },
    });
    await prisma.liveStream.update({ where: { id: stream.id }, data: { recResourceId: resourceId, recSid: st.sid, recState: 'recording' } });
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, '[Live] запись эфира не запустилась');
    await prisma.liveStream.update({ where: { id: stream.id }, data: { recState: 'failed' } }).catch(() => undefined);
  }
}

/** Остановить запись (если шла). Файлы Agora догружает в R2 сама; ссылку найдём по папке. */
export async function stopRecording(stream: { id: string; channel: string; recResourceId?: string | null; recSid?: string | null; recState?: string | null }): Promise<void> {
  if (stream.recState !== 'recording' || !stream.recResourceId || !stream.recSid || !recordingConfigured()) return;
  try {
    const r = await agoraRest(`/resourceid/${stream.recResourceId}/sid/${stream.recSid}/mode/mix/stop`, {
      cname: stream.channel, uid: RECORDER_UID, clientRequest: {},
    });
    const files: any[] = r?.serverResponse?.fileList ?? [];
    const mp4 = (Array.isArray(files) ? files : []).map((f) => (typeof f === 'string' ? f : f?.fileName)).find((n) => typeof n === 'string' && n.endsWith('.mp4'));
    await prisma.liveStream.update({ where: { id: stream.id }, data: { recState: 'stopped', ...(mp4 ? { replayUrl: r2PublicUrl(mp4) } : {}) } });
  } catch (err: any) {
    // Запись могла уже остановиться сама (maxIdleTime) — это нормально, файл найдём в R2.
    logger.warn({ err: String(err?.message ?? err) }, '[Live] остановка записи');
    await prisma.liveStream.update({ where: { id: stream.id }, data: { recState: 'stopped' } }).catch(() => undefined);
  }
}

/** Для завершённых эфиров без ссылки на повтор — ищем mp4 в папке записи в R2. */
export async function resolveReplays(limit = 5): Promise<void> {
  if (!isR2Configured()) return;
  const since = new Date(Date.now() - 3 * 24 * 60 * 60_000);
  const rows: any[] = await prisma.liveStream.findMany({
    where: { status: 'ended', replayUrl: null, recState: { in: ['recording', 'stopped'] }, endedAt: { gte: since } },
    orderBy: { endedAt: 'desc' },
    take: limit,
  });
  for (const s of rows) {
    try {
      if (s.recState === 'recording') await stopRecording(s);
      const keys = await r2ListKeys(replayPrefix(s.id).join('/') + '/');
      const mp4 = keys.filter((k) => k.endsWith('.mp4')).sort()[0];
      if (mp4) await prisma.liveStream.update({ where: { id: s.id }, data: { replayUrl: r2PublicUrl(mp4), recState: 'stopped' } });
    } catch (err: any) {
      logger.warn({ err: String(err?.message ?? err) }, '[Live] поиск файла повтора');
    }
  }
}


// ---------------------------------------------------------------------------
// Сколько зрителей сейчас в эфире — у Agora (REST «пользователи канала»), кэш 20 с.
// ---------------------------------------------------------------------------

const viewersCache = new Map<string, { at: number; n: number }>();

export async function viewersOf(channel: string): Promise<number> {
  const hit = viewersCache.get(channel);
  if (hit && Date.now() - hit.at < 20_000) return hit.n;
  const id = process.env.AGORA_CUSTOMER_ID?.trim();
  const secret = process.env.AGORA_CUSTOMER_SECRET?.trim();
  if (!id || !secret) return hit?.n ?? 0;
  try {
    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const res = await fetchImpl(`https://api.agora.io/dev/v1/channel/user/${AGORA_APP_ID}/${encodeURIComponent(channel)}`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5_000),
    } as any);
    const data: any = await res.json().catch(() => ({}));
    const d = data?.data ?? {};
    const n = Number(d.audience_total ?? (Array.isArray(d.audience) ? d.audience.length : 0)) || 0;
    viewersCache.set(channel, { at: Date.now(), n });
    return n;
  } catch {
    return hit?.n ?? 0;
  }
}


/** Покупатели с «колокольчиком» на этого креатора получают пуш: эфир начался. */
export async function notifyFollowers(stream: { id: string; creatorId: string; title: string }, creatorName: string): Promise<number> {
  try {
    // Подписчики креатора + те, кто нажал «Напомнить» у анонса именно этого эфира.
    const [follows, reminders]: any[][] = await Promise.all([
      prisma.liveFollow.findMany({ where: { creatorId: stream.creatorId }, take: 5000 }),
      prisma.liveReminder.findMany({ where: { streamId: stream.id }, take: 5000 }),
    ]);
    const rows = [...follows, ...reminders];
    if (!rows.length) return 0;
    const phones = rows.filter((r) => !r.pushToken && r.phone).map((r) => r.phone as string);
    const byPhone: any[] = phones.length ? await prisma.shopCustomerPushToken.findMany({ where: { phone: { in: phones } } }) : [];
    const tokens = Array.from(new Set([...rows.map((r) => r.pushToken).filter(Boolean), ...byPhone.map((t) => t.token)])) as string[];
    if (!tokens.length) return 0;
    const { sendBroadcast } = await import('./pushBroadcast.service');
    await sendBroadcast({
      title: `${creatorName || 'Креатор'} в эфире`,
      body: `«${stream.title}» — заходите, смотрите и покупайте`,
      tokens,
      data: { type: 'live', streamId: stream.id },
    });
    return tokens.length;
  } catch (err) {
    logger.error({ err }, '[Live] пуш подписчикам не ушёл');
    return 0;
  }
}

export function bannerDto(b: any) {
  return { id: b.id, imageUrl: b.imageUrl, title: b.title ?? '', linkType: b.linkType ?? '', linkValue: b.linkValue ?? '' };
}

// ---------------------------------------------------------------------------
// Топ-10 по продажам за 7 дней: сколько штук товаров эфира/ролика продано
// (оплаченные заказы My Market). Прямой связи «заказ ← эфир» нет, поэтому
// считаем продажи его артикулов — как «эфиры, товары которых покупают».
// ---------------------------------------------------------------------------

const SOLD_STATUSES = ['paid', 'picked', 'in_transit', 'delivered'];

export async function soldBySku(days = 7, now = Date.now()): Promise<Map<string, number>> {
  const since = new Date(now - days * 24 * 60 * 60_000);
  const orders: Array<{ items: string }> = await prisma.shopOrder.findMany({
    where: { status: { in: SOLD_STATUSES }, OR: [{ paidAt: { gte: since } }, { paidAt: null, createdAt: { gte: since } }] },
    select: { items: true },
    take: 5000,
  });
  const out = new Map<string, number>();
  for (const o of orders) {
    let items: any[] = [];
    try { items = JSON.parse(o.items); } catch { items = []; }
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const sku = String(it?.sku ?? '');
      const q = Number(it?.quantity ?? 1) || 0;
      if (sku && q > 0) out.set(sku, (out.get(sku) ?? 0) + q);
    }
  }
  return out;
}

export type TopEntry = { kind: 'stream' | 'short'; id: string; sold: number };

/** Топ-10: сначала по проданным штукам, при равенстве — по просмотрам. Анонсы не участвуют. */
export function topBySales(
  streams: Array<{ id: string; skus: string[]; views: number }>,
  shorts: Array<{ id: string; skus: string[]; views: number }>,
  sold: Map<string, number>,
  limit = 10,
): TopEntry[] {
  const score = (skus: string[]) => Array.from(new Set(skus)).reduce((n, s) => n + (sold.get(s) ?? 0), 0);
  const all = [
    ...streams.map((s) => ({ kind: 'stream' as const, id: s.id, sold: score(s.skus), views: s.views })),
    ...shorts.map((v) => ({ kind: 'short' as const, id: v.id, sold: score(v.skus), views: v.views })),
  ];
  return all
    .filter((x) => x.sold > 0 || x.views > 0)
    .sort((a, b) => b.sold - a.sold || b.views - a.views)
    .slice(0, limit)
    .map(({ kind, id, sold: n }) => ({ kind, id, sold: n }));
}
