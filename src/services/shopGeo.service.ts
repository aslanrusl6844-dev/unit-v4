import { prisma } from '../db/prisma';
import { CITY_IMAGE_CITIES, resolveCity } from '../config/cities';

/**
 * Карта доставок My Market: заказы и поисковые запросы по городам приложения
 * (тот же список из 20 городов, что и в настройках приложения/«Картинки городов»),
 * плюс «машины в пути» — заказы picked/in_transit, сгруппированные по городу.
 * Хаб — Алматы. Всё считается только по каналу APP (ShopOrder / ShopEvent).
 */

export const HUB_CITY = 'Алматы';

export type GeoOrderRow = {
  city: string;
  status: string;
  total: number;
  items: string;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
};
export type GeoSearchRow = { city: string | null; query: string | null; phone: string | null; id: string };

export type GeoCity = {
  city: string;
  orders: number;          // заказы, поступившие за период (не «ожидает оплаты» и не отменённые)
  revenue: number;
  topItems: Array<{ name: string; qty: number }>;
  searches: number;        // поисковые запросы из этого города
  topQueries: Array<{ query: string; count: number }>;
  paid: number;            // оплачен, ещё не забран
  inTransit: number;       // курьер забрал / в пути
  transitSince: string | null; // с какого момента первый из них перешёл в «забран/в пути»
  delivered: number;
  lastDeliveredAt: string | null;
};

function parseItems(raw: string): Array<{ name: string; quantity: number }> {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((i: any) => ({ name: String(i?.name ?? '').trim(), quantity: Number(i?.quantity) > 0 ? Number(i.quantity) : 1 }))
      .filter((i) => i.name);
  } catch {
    return [];
  }
}

function topN(m: Map<string, number>, n: number): Array<[string, number]> {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Чистая функция — вся логика агрегации здесь, чтобы её можно было проверить тестом без БД. */
export function buildGeo(orders: GeoOrderRow[], searches: GeoSearchRow[]) {
  const cities = new Map<string, GeoCity & { _items: Map<string, number>; _queries: Map<string, number>; _since: number | null; _lastDel: number | null }>();
  for (const c of CITY_IMAGE_CITIES) {
    cities.set(c, {
      city: c, orders: 0, revenue: 0, topItems: [], searches: 0, topQueries: [], paid: 0, inTransit: 0,
      transitSince: null, delivered: 0, lastDeliveredAt: null,
      _items: new Map(), _queries: new Map(), _since: null, _lastDel: null,
    });
  }
  let otherOrders = 0;
  let otherSearches = 0;

  for (const o of orders) {
    if (o.status === 'pending_payment' || o.status === 'cancelled') continue;
    const name = resolveCity(o.city);
    const c = name ? cities.get(name) : null;
    if (!c) { otherOrders++; continue; }
    c.orders++;
    c.revenue += o.total;
    for (const it of parseItems(o.items)) c._items.set(it.name, (c._items.get(it.name) ?? 0) + it.quantity);
    if (o.status === 'paid') c.paid++;
    else if (o.status === 'picked' || o.status === 'in_transit') {
      c.inTransit++;
      const t = o.updatedAt.getTime();
      c._since = c._since == null ? t : Math.min(c._since, t);
    } else if (o.status === 'delivered') {
      c.delivered++;
      const t = (o.deliveredAt ?? o.updatedAt).getTime();
      c._lastDel = c._lastDel == null ? t : Math.max(c._lastDel, t);
    }
  }

  for (const s of searches) {
    const q = (s.query ?? '').trim().toLowerCase();
    if (!q) continue;
    const name = resolveCity(s.city);
    const c = name ? cities.get(name) : null;
    if (!c) { otherSearches++; continue; }
    c.searches++;
    c._queries.set(q, (c._queries.get(q) ?? 0) + 1);
  }

  const list: GeoCity[] = Array.from(cities.values()).map((c) => ({
    city: c.city,
    orders: c.orders,
    revenue: Math.round(c.revenue),
    topItems: topN(c._items, 3).map(([name, qty]) => ({ name, qty })),
    searches: c.searches,
    topQueries: topN(c._queries, 3).map(([query, count]) => ({ query, count })),
    paid: c.paid,
    inTransit: c.inTransit,
    transitSince: c._since == null ? null : new Date(c._since).toISOString(),
    delivered: c.delivered,
    lastDeliveredAt: c._lastDel == null ? null : new Date(c._lastDel).toISOString(),
  }));

  return { hub: HUB_CITY, cities: list, otherOrders, otherSearches };
}

export async function getGeoAnalytics(days: number) {
  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);
  const [orders, searches] = await Promise.all([
    prisma.shopOrder.findMany({
      where: days > 0 ? { createdAt: { gte: from } } : {},
      select: { city: true, status: true, total: true, items: true, createdAt: true, updatedAt: true, deliveredAt: true },
    }),
    prisma.shopEvent.findMany({
      where: { type: 'search', ...(days > 0 ? { createdAt: { gte: from } } : {}) },
      select: { id: true, city: true, query: true, phone: true },
    }),
  ]);
  return buildGeo(orders as GeoOrderRow[], searches);
}
