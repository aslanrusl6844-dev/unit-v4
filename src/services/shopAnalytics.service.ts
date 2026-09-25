import { prisma } from '../db/prisma';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Заказы канала APP за период — читаем ShopOrder напрямую (не через
 * ShopEvent), т.к. заказ как факт уже пишется туда при POST /orders и не
 * дублируется отдельным событием (см. shop.routes.ts POST /events).
 * "Оплаченный" здесь — статус не pending_payment и не cancelled.
 */
async function getAppOrdersInRange(from: Date) {
  return prisma.shopOrder.findMany({
    where: { createdAt: { gte: from } },
    select: { id: true, phone: true, city: true, total: true, status: true, createdAt: true, items: true },
  });
}

function isPaidStatus(status: string): boolean {
  return status !== 'pending_payment' && status !== 'cancelled';
}

/** А) Поисковые запросы — с разбивкой по городам внутри каждой строки. */
export async function getSearchAnalytics(days: number) {
  const from = daysAgo(days);
  const [searchEvents, orders] = await Promise.all([
    prisma.shopEvent.findMany({ where: { type: 'search', createdAt: { gte: from } } }),
    getAppOrdersInRange(from),
  ]);

  const byQuery = new Map<string, typeof searchEvents>();
  for (const e of searchEvents) {
    if (!e.query) continue; // search без query не должно было записаться, но на всякий случай не считаем такие
    if (!byQuery.has(e.query)) byQuery.set(e.query, []);
    byQuery.get(e.query)!.push(e);
  }

  const rows = Array.from(byQuery.entries()).map(([query, events]) => {
    const searchCount = events.length;
    // Уникальные люди: по телефону, но без телефона — каждый search как отдельный человек.
    const uniqueKeySet = new Set(events.map((e) => (e.phone ? `p:${e.phone}` : `e:${e.id}`)));
    const uniquePeople = uniqueKeySet.size;

    // Заказали после поиска: тот же phone, ShopOrder создан в течение 24ч
    // ПОСЛЕ хотя бы одного search-события с этим запросом.
    const phonesWithSearch: string[] = Array.from(new Set(events.filter((e) => e.phone).map((e) => e.phone as string)));
    const orderedPhones = new Set<string>();
    const matchedOrderIds = new Set<string>();
    for (const phone of phonesWithSearch) {
      const searchTimes = events.filter((e) => e.phone === phone).map((e) => e.createdAt.getTime());
      const matches = orders.filter((o) => {
        if (o.phone !== phone) return false;
        const ot = o.createdAt.getTime();
        return searchTimes.some((t) => ot >= t && ot <= t + DAY_MS);
      });
      if (matches.length) {
        orderedPhones.add(phone);
        matches.forEach((o) => matchedOrderIds.add(o.id));
      }
    }
    const orderedRevenue = orders.filter((o) => matchedOrderIds.has(o.id)).reduce((s, o) => s + o.total, 0);

    const resultsCounts = events.filter((e) => e.resultsCount != null).map((e) => e.resultsCount as number);
    const avgResultsCount = resultsCounts.length ? resultsCounts.reduce((a, b) => a + b, 0) / resultsCounts.length : null;
    const zeroResultsCount = events.filter((e) => e.resultsCount === 0).length;

    // Разбивка по городам — внутри запроса, по числу уникальных людей убыв., "без города" в конец.
    const cityMap = new Map<string, Set<string>>();
    for (const e of events) {
      const cityKey = e.city || '';
      if (!cityMap.has(cityKey)) cityMap.set(cityKey, new Set());
      cityMap.get(cityKey)!.add(e.phone ? `p:${e.phone}` : `e:${e.id}`);
    }
    const cities = Array.from(cityMap.entries())
      .map(([city, keys]) => ({
        city: city || 'без города',
        uniquePeople: keys.size,
        percent: uniquePeople > 0 ? round1((keys.size / uniquePeople) * 100) : 0,
      }))
      .sort((a, b) => {
        if (a.city === 'без города') return 1;
        if (b.city === 'без города') return -1;
        return b.uniquePeople - a.uniquePeople;
      });

    return {
      query,
      searchCount,
      uniquePeople,
      orderedAfterSearch: orderedPhones.size,
      orderedRevenue: round2(orderedRevenue),
      avgResultsCount: avgResultsCount != null ? round1(avgResultsCount) : null,
      zeroResultsCount,
      cities,
    };
  });

  rows.sort((a, b) => b.searchCount - a.searchCount);
  return rows;
}

/** Б) Конверсия по SKU — товары без событий (ни view, ни cart) не показываем. */
export async function getConversionAnalytics(days: number) {
  const from = daysAgo(days);
  const [viewEvents, cartEvents, orders] = await Promise.all([
    prisma.shopEvent.findMany({ where: { type: 'view', createdAt: { gte: from }, sku: { not: null } } }),
    prisma.shopEvent.findMany({ where: { type: 'cart', createdAt: { gte: from }, sku: { not: null } } }),
    getAppOrdersInRange(from),
  ]);

  const skuSet = new Set<string>([
    ...viewEvents.map((e) => e.sku as string),
    ...cartEvents.map((e) => e.sku as string),
  ]);
  if (!skuSet.size) return [];

  const products = await prisma.product.findMany({ where: { sku: { in: Array.from(skuSet) } }, select: { sku: true, name: true } });
  const nameBySku = new Map(products.map((p) => [p.sku, p.name]));

  const rows = Array.from(skuSet).map((sku) => {
    const views = viewEvents.filter((e) => e.sku === sku).length;
    const cart = cartEvents.filter((e) => e.sku === sku).length;
    let ordersCount = 0;
    let payments = 0;
    for (const o of orders) {
      let items: Array<{ sku: string }> = [];
      try {
        items = JSON.parse(o.items);
      } catch {
        items = [];
      }
      if (items.some((i) => i.sku === sku)) {
        ordersCount += 1;
        if (isPaidStatus(o.status)) payments += 1;
      }
    }
    return {
      sku,
      name: nameBySku.get(sku) ?? sku,
      views,
      cart,
      orders: ordersCount,
      payments,
      cartPct: views > 0 ? round1((cart / views) * 100) : 0,
      orderPct: cart > 0 ? round1((ordersCount / cart) * 100) : 0,
    };
  });

  rows.sort((a, b) => b.views - a.views);
  return rows;
}

/** В) Сезонность по дням + отдельная таблица городов. */
export async function getSeasonalityAnalytics(days: number) {
  const from = daysAgo(days);
  const [searchEvents, cartEvents, orders] = await Promise.all([
    prisma.shopEvent.findMany({ where: { type: 'search', createdAt: { gte: from } } }),
    prisma.shopEvent.findMany({ where: { type: 'cart', createdAt: { gte: from } } }),
    getAppOrdersInRange(from),
  ]);

  const dayMap = new Map<string, { searches: number; cart: number; orders: number; paidRevenue: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    dayMap.set(dayKey(d), { searches: 0, cart: 0, orders: 0, paidRevenue: 0 });
  }
  for (const e of searchEvents) {
    const bucket = dayMap.get(dayKey(e.createdAt));
    if (bucket) bucket.searches += 1;
  }
  for (const e of cartEvents) {
    const bucket = dayMap.get(dayKey(e.createdAt));
    if (bucket) bucket.cart += 1;
  }
  for (const o of orders) {
    const bucket = dayMap.get(dayKey(o.createdAt));
    if (bucket) {
      bucket.orders += 1;
      if (isPaidStatus(o.status)) bucket.paidRevenue += o.total;
    }
  }
  const daily = Array.from(dayMap.entries()).map(([date, v]) => ({
    date,
    searches: v.searches,
    cart: v.cart,
    orders: v.orders,
    paidRevenue: round2(v.paidRevenue),
  }));

  // Города — поиски/уникальные из ShopEvent.city (воронка), заказы/сумма
  // из ShopOrder.city (адрес доставки) — заказ отдельным событием city не
  // дублируется, поэтому для заказов город берём из самого ShopOrder.
  const cityStats = new Map<string, { searches: number; uniqueKeys: Set<string>; orders: number; revenue: number }>();
  function ensureCity(city: string) {
    if (!cityStats.has(city)) cityStats.set(city, { searches: 0, uniqueKeys: new Set(), orders: 0, revenue: 0 });
    return cityStats.get(city)!;
  }
  for (const e of searchEvents) {
    const bucket = ensureCity(e.city || 'без города');
    bucket.searches += 1;
    bucket.uniqueKeys.add(e.phone ? `p:${e.phone}` : `e:${e.id}`);
  }
  for (const o of orders) {
    const bucket = ensureCity(o.city?.trim() || 'без города');
    bucket.orders += 1;
    if (isPaidStatus(o.status)) bucket.revenue += o.total;
  }
  const cities = Array.from(cityStats.entries())
    .map(([city, v]) => ({
      city,
      searches: v.searches,
      uniquePeople: v.uniqueKeys.size,
      orders: v.orders,
      revenue: round2(v.revenue),
    }))
    .sort((a, b) => {
      if (a.city === 'без города') return 1;
      if (b.city === 'без города') return -1;
      return b.searches - a.searches;
    });

  return { daily, cities };
}
