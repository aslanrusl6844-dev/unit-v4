import { prisma } from '../db/prisma';
import { isOnAir, parseSkus, shopCategoryBySku, soldBySku, streamDto, videoDto } from './live.service';
import { creatorGiftCoins } from './liveGifts.service';

/**
 * Креаторы в Live (как «Рекомендуемые креаторы» у Coupang): фото, имя, раздел, подписчики, ♥, подарки, продажи.
 * Раздел — из админки или сам: раздел каталога, товары которого креатор показывает чаще всего.
 */

export type CreatorCard = {
  id: string; name: string; avatarUrl: string; category: string; followers: number; likes: number;
  giftCoins: number; sold: number; featured: boolean; live: boolean; following: boolean;
};

/** Самый частый раздел каталога среди товаров креатора. */
export function mainCategory(skus: string[], bySku: Map<string, string>): string {
  const count = new Map<string, number>();
  for (const s of skus) {
    const c = bySku.get(s);
    if (c) count.set(c, (count.get(c) ?? 0) + 1);
  }
  let best = '';
  let n = 0;
  for (const [c, k] of count) if (k > n) { best = c; n = k; }
  return best;
}

/** Порядок в топе: «Рекомендовать» из админки, потом подписчики, ♥, подарки и продажи. */
export function creatorScore(c: Pick<CreatorCard, 'featured' | 'followers' | 'likes' | 'giftCoins' | 'sold' | 'live'>): number {
  return (c.featured ? 1e12 : 0) + (c.live ? 1e6 : 0) + c.followers * 20 + c.likes + c.giftCoins * 5 + c.sold * 100;
}

export async function listCreators(device = '', now = Date.now()): Promise<CreatorCard[]> {
  const creators: any[] = await prisma.creator.findMany({ where: { active: true }, take: 500 });
  if (!creators.length) return [];
  const ids = creators.map((c) => c.id);
  const [videos, streams, follows, gifts, sold]: [any[], any[], any[], Map<string, number>, Map<string, number>] = await Promise.all([
    prisma.creatorVideo.findMany({ where: { creatorId: { in: ids }, status: 'published' }, select: { creatorId: true, skus: true, likes: true }, take: 10000 }),
    prisma.liveStream.findMany({ where: { creatorId: { in: ids } }, select: { creatorId: true, skus: true, likes: true, status: true, lastBeatAt: true, startedAt: true }, take: 10000 }),
    prisma.liveFollow.findMany({ where: { creatorId: { in: ids } }, select: { creatorId: true, deviceKey: true }, take: 200000 }),
    creatorGiftCoins(ids),
    soldBySku(7, now).catch(() => new Map<string, number>()),
  ]);
  const skusOf = new Map<string, string[]>();
  const likesOf = new Map<string, number>();
  const liveNow = new Set<string>();
  for (const r of [...videos, ...streams]) {
    skusOf.set(r.creatorId, [...(skusOf.get(r.creatorId) ?? []), ...parseSkus(r.skus)]);
    likesOf.set(r.creatorId, (likesOf.get(r.creatorId) ?? 0) + (r.likes ?? 0));
  }
  for (const s of streams) if (s.status === 'live' && isOnAir(s, now)) liveNow.add(s.creatorId);
  const bySku = await shopCategoryBySku(Array.from(skusOf.values()).flat());
  const followers = new Map<string, number>();
  const mine = new Set<string>();
  for (const f of follows) {
    followers.set(f.creatorId, (followers.get(f.creatorId) ?? 0) + 1);
    if (device && f.deviceKey === device) mine.add(f.creatorId);
  }
  const cards: CreatorCard[] = creators.map((c) => {
    const skus = skusOf.get(c.id) ?? [];
    return {
      id: c.id,
      name: c.name,
      avatarUrl: c.avatarUrl ?? '',
      category: c.category || mainCategory(skus, bySku),
      followers: followers.get(c.id) ?? 0,
      likes: likesOf.get(c.id) ?? 0,
      giftCoins: gifts.get(c.id) ?? 0,
      sold: Array.from(new Set(skus)).reduce((n, s) => n + (sold.get(s) ?? 0), 0),
      featured: !!c.featured,
      live: liveNow.has(c.id),
      following: mine.has(c.id),
    };
  });
  return cards.sort((a, b) => creatorScore(b) - creatorScore(a));
}

/** Страница креатора: карточка + эфиры, повторы, анонсы, шортс и все его товары. */
export async function creatorPage(id: string, device = '', now = Date.now()) {
  const all = await listCreators(device, now);
  const card = all.find((c) => c.id === id);
  if (!card) return null;
  const [streams, videos]: [any[], any[]] = await Promise.all([
    prisma.liveStream.findMany({ where: { creatorId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.creatorVideo.findMany({ where: { creatorId: id, status: 'published' }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  const dtos = streams.map((s) => streamDto(s, card.name));
  const live = dtos.filter((s) => s.status === 'live');
  const replays = dtos.filter((s) => s.status === 'ended' && s.replayUrl);
  const upcoming = dtos
    .filter((s) => s.status === 'scheduled' && s.scheduledAt && new Date(s.scheduledAt).getTime() >= now - 60 * 60_000)
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const shorts = videos.map((v) => videoDto(v, card.name));
  const skus = Array.from(new Set([...live, ...replays, ...upcoming, ...shorts].flatMap((x) => x.skus)));
  return { creator: card, live, replays, upcoming, shorts, skus };
}
