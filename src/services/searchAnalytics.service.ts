import dayjs from 'dayjs';
import googleTrends from 'google-trends-api';
import { prisma } from '../db/prisma';
import { NON_SALE_STATUSES } from './analytics.service';

/** Регионы Казахстана для Google Trends (коды Google; список можно расширять). */
export const TRENDS_REGIONS: Record<string, string> = {
  KZ: 'Казахстан',
  'KZ-ALA': 'Алматы',
  'KZ-AST': 'Астана',
  'KZ-SHY': 'Шымкент',
};

const MARKETPLACES = ['KASPI', 'OZON', 'WB', 'TEEZ', 'APP'] as const;
type Mp = (typeof MARKETPLACES)[number];

export interface MySalesMonth {
  month: string; // YYYY-MM
  byMarketplace: Partial<Record<Mp, { quantity: number; revenue: number }>>;
  quantity: number;
  revenue: number;
}

export interface MySalesResult {
  keyword: string;
  from: string;
  to: string;
  months: MySalesMonth[];
  totals: Partial<Record<Mp, { quantity: number; revenue: number }>> & { all: { quantity: number; revenue: number } };
  topProducts: Array<{ name: string; quantity: number; revenue: number }>;
  truncated: boolean;
}

const ITEM_LIMIT = 50_000;

/**
 * Продажи ТВОИХ товаров, в названии которых есть слово — по месяцам и площадкам.
 * Считаются только заказы, не входящие в NON_SALE_STATUSES (без отмен и возвратов).
 * Это данные из нашей базы, не оценка.
 */
export async function getMySalesByKeyword(
  keyword: string,
  from: Date,
  to: Date,
  db: { orderItem: { findMany: (args: any) => Promise<any[]> } } = prisma as any,
): Promise<MySalesResult> {
  const words = keyword.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  const items: any[] = await db.orderItem.findMany({
    where: {
      AND: words.map((w) => ({ name: { contains: w, mode: 'insensitive' as const } })),
      order: { orderDate: { gte: from, lte: to }, status: { notIn: NON_SALE_STATUSES } },
    },
    select: { name: true, quantity: true, price: true, order: { select: { marketplace: true, orderDate: true } } },
    take: ITEM_LIMIT + 1,
  });
  const truncated = items.length > ITEM_LIMIT;
  if (truncated) items.length = ITEM_LIMIT;

  // Пустые месяцы тоже показываем — иначе график «проваливается» без объяснения.
  const monthMap = new Map<string, MySalesMonth>();
  for (let m = dayjs(from).startOf('month'); !m.isAfter(to); m = m.add(1, 'month')) {
    monthMap.set(m.format('YYYY-MM'), { month: m.format('YYYY-MM'), byMarketplace: {}, quantity: 0, revenue: 0 });
  }

  const totals: MySalesResult['totals'] = { all: { quantity: 0, revenue: 0 } };
  const products = new Map<string, { name: string; quantity: number; revenue: number }>();

  for (const it of items) {
    const key = dayjs(it.order.orderDate).format('YYYY-MM');
    const bucket = monthMap.get(key);
    if (!bucket) continue;
    const mp = it.order.marketplace as Mp;
    const revenue = it.price * it.quantity;

    const cell = (bucket.byMarketplace[mp] ??= { quantity: 0, revenue: 0 });
    cell.quantity += it.quantity;
    cell.revenue += revenue;
    bucket.quantity += it.quantity;
    bucket.revenue += revenue;

    const tot = (totals[mp] ??= { quantity: 0, revenue: 0 });
    tot.quantity += it.quantity;
    tot.revenue += revenue;
    totals.all.quantity += it.quantity;
    totals.all.revenue += revenue;

    const p = products.get(it.name) ?? { name: it.name, quantity: 0, revenue: 0 };
    p.quantity += it.quantity;
    p.revenue += revenue;
    products.set(it.name, p);
  }

  const round = (n: number) => Math.round(n);
  const months = [...monthMap.values()].map((m) => ({
    ...m,
    revenue: round(m.revenue),
    byMarketplace: Object.fromEntries(
      Object.entries(m.byMarketplace).map(([k, v]) => [k, { quantity: v!.quantity, revenue: round(v!.revenue) }]),
    ) as MySalesMonth['byMarketplace'],
  }));
  for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k]!.revenue = round(totals[k]!.revenue);

  return {
    keyword,
    from: dayjs(from).format('YYYY-MM-DD'),
    to: dayjs(to).format('YYYY-MM-DD'),
    months,
    totals,
    topProducts: [...products.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((p) => ({ ...p, revenue: round(p.revenue) })),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Google Trends (неофициально: у Google нет открытого API Trends)
// ---------------------------------------------------------------------------

export interface TrendsResult {
  keyword: string;
  geo: string;
  geoLabel: string;
  timeline: Array<{ date: string; value: number }>;
  relatedTop: Array<{ query: string; value: number }>;
  relatedRising: Array<{ query: string; value: string }>;
}

/** Ответ Trends — JSON, но при блокировке приходит HTML; делаем из этого понятную ошибку. */
export function parseTrendsJson<T>(raw: string, what: string): T {
  const text = String(raw ?? '').trim();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    throw new Error(`Google Trends не отдал данные (${what}): сервер вернул не JSON — вероятно, временно ограничил запросы с нашего хостинга.`);
  }
  return JSON.parse(text) as T;
}

export function mapTimeline(json: any): TrendsResult['timeline'] {
  const points: any[] = json?.default?.timelineData ?? [];
  return points.map((p) => ({
    date: dayjs.unix(Number(p.time)).format('YYYY-MM-DD'),
    value: Number(Array.isArray(p.value) ? p.value[0] : p.value) || 0,
  }));
}

export function mapRelated(json: any): { top: TrendsResult['relatedTop']; rising: TrendsResult['relatedRising'] } {
  const lists: any[] = json?.default?.rankedList ?? [];
  const top = (lists[0]?.rankedKeyword ?? []).map((k: any) => ({ query: String(k.query), value: Number(k.value) || 0 }));
  const rising = (lists[1]?.rankedKeyword ?? []).map((k: any) => ({
    query: String(k.query),
    value: k.formattedValue ? String(k.formattedValue) : String(k.value ?? ''),
  }));
  return { top: top.slice(0, 25), rising: rising.slice(0, 25) };
}

export async function getGoogleTrends(keyword: string, geo: string, months: number): Promise<TrendsResult> {
  if (!(geo in TRENDS_REGIONS)) throw new Error('Неизвестный регион');
  const endTime = new Date();
  const startTime = dayjs(endTime).subtract(Math.min(Math.max(months, 1), 60), 'month').toDate();
  const opts = { keyword, geo, startTime, endTime, hl: 'ru', timezone: -300 };

  const timeline = mapTimeline(parseTrendsJson(await googleTrends.interestOverTime(opts), 'динамика'));
  // Связанные запросы — вторым запросом; если Google на нём откажет, динамику всё равно покажем.
  let related: ReturnType<typeof mapRelated> = { top: [], rising: [] };
  try {
    related = mapRelated(parseTrendsJson(await googleTrends.relatedQueries(opts), 'связанные запросы'));
  } catch {
    /* оставляем пустые списки */
  }
  return {
    keyword,
    geo,
    geoLabel: TRENDS_REGIONS[geo],
    timeline,
    relatedTop: related.top,
    relatedRising: related.rising,
  };
}
