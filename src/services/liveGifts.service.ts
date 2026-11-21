import dayjs from 'dayjs';
import { prisma } from '../db/prisma';
import { ALMATY_TZ } from '../utils/timezone';

/**
 * Подарки и события эфира — как в ТикТок Live.
 * Пока подарки бесплатные: каждому зрителю (устройству) на день даётся DAILY_FREE_COINS монет.
 * Подарок идёт креатору эфира (LiveGiftSend.creatorId) — потом из этого сделаем платную схему.
 */

export const DAILY_FREE_COINS = 100;

/** Набор подарков, если в админке ещё пусто. */
export const DEFAULT_GIFTS: Array<{ title: string; emoji: string; coins: number }> = [
  { title: 'Роза', emoji: '🌹', coins: 1 },
  { title: 'Сердечко', emoji: '❤️', coins: 1 },
  { title: 'Мороженое', emoji: '🍦', coins: 1 },
  { title: 'Пончик', emoji: '🍩', coins: 5 },
  { title: 'Кусок торта', emoji: '🍰', coins: 5 },
  { title: 'Корги', emoji: '🐶', coins: 10 },
  { title: 'Мишка', emoji: '🧸', coins: 15 },
  { title: 'Букет', emoji: '💐', coins: 20 },
  { title: 'Духи', emoji: '🌸', coins: 30 },
  { title: 'Корона', emoji: '👑', coins: 50 },
  { title: 'Бриллиант', emoji: '💎', coins: 70 },
  { title: 'Ракета', emoji: '🚀', coins: 100 },
];

export function giftDto(g: any) {
  return { id: g.id, title: g.title, emoji: g.emoji ?? '🎁', imageUrl: g.imageUrl ?? '', animUrl: g.animUrl ?? '', coins: g.coins, sort: g.sort ?? 0, active: g.active !== false };
}

export async function activeGifts(): Promise<any[]> {
  let rows: any[] = await prisma.liveGift.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { coins: 'asc' }] });
  if (!rows.length) {
    const any = await prisma.liveGift.findMany({ take: 1 });
    if (!any.length) {
      for (const [i, g] of DEFAULT_GIFTS.entries()) await prisma.liveGift.create({ data: { ...g, sort: i + 1, active: true } });
      rows = await prisma.liveGift.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { coins: 'asc' }] });
    }
  }
  return rows;
}

/** Начало сегодняшнего дня по Алматы — с него считаются бесплатные монеты. */
export function todayStart(now = Date.now()): Date {
  return dayjs(now).tz(ALMATY_TZ).startOf('day').toDate();
}

/** Сколько бесплатных монет осталось у устройства сегодня. */
export async function coinsLeft(device: string, now = Date.now()): Promise<number> {
  if (!device) return 0;
  const sent: Array<{ coins: number }> = await prisma.liveGiftSend.findMany({
    where: { deviceKey: device, createdAt: { gte: todayStart(now) } },
    select: { coins: true },
  });
  return Math.max(0, DAILY_FREE_COINS - sent.reduce((n, r) => n + (r.coins ?? 0), 0));
}

/** Топ дарителей эфира: имя и сумма монет (для аватарок сверху, как у ТикТока). */
export async function topGifters(streamId: string, limit = 3): Promise<Array<{ name: string; coins: number }>> {
  const rows: Array<{ name: string; deviceKey: string; coins: number }> = await prisma.liveGiftSend.findMany({
    where: { streamId }, select: { name: true, deviceKey: true, coins: true }, take: 5000,
  });
  const by = new Map<string, { name: string; coins: number }>();
  for (const r of rows) {
    const cur = by.get(r.deviceKey) ?? { name: r.name, coins: 0 };
    cur.coins += r.coins;
    cur.name = r.name;
    by.set(r.deviceKey, cur);
  }
  return Array.from(by.values()).sort((a, b) => b.coins - a.coins).slice(0, limit);
}

/** Сколько монет подарков получил креатор (всего). */
export async function creatorGiftCoins(creatorIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!creatorIds.length) return out;
  const rows: Array<{ creatorId: string; coins: number }> = await prisma.liveGiftSend.findMany({
    where: { creatorId: { in: creatorIds } }, select: { creatorId: true, coins: true }, take: 50000,
  });
  for (const r of rows) out.set(r.creatorId, (out.get(r.creatorId) ?? 0) + r.coins);
  return out;
}

/** Событие в чате эфира: «теперь с нами», «отправил лайки», «поделился», «отправил подарок». */
export async function chatEvent(streamId: string, kind: 'join' | 'like' | 'share' | 'gift', name: string, text: string, meta?: Record<string, unknown>) {
  return prisma.liveChatMessage.create({
    data: { streamId, name: name || 'Гость', text, kind, meta: meta ? JSON.stringify(meta) : null, fromHost: false },
  });
}

// Не засоряем чат: одно событие «зашёл» на устройство за 10 минут, «лайки» — раз в 15 секунд.
const lastEvent = new Map<string, number>();
export function eventAllowed(key: string, gapMs: number, now = Date.now()): boolean {
  const last = lastEvent.get(key) ?? 0;
  if (now - last < gapMs) return false;
  lastEvent.set(key, now);
  if (lastEvent.size > 20000) lastEvent.clear();
  return true;
}
export function resetEventThrottle() { lastEvent.clear(); }

export function chatDto(m: any) {
  let meta: any = null;
  if (m.meta) { try { meta = JSON.parse(m.meta); } catch { meta = null; } }
  return { id: m.id, name: m.name, text: m.text, fromHost: !!m.fromHost, kind: m.kind ?? 'text', meta };
}

export function cleanName(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 30) || 'Гость';
}
