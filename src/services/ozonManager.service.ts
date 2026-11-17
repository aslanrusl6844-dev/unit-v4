import dayjs from 'dayjs';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { ozonClient } from '../integrations/ozon.client';
import { getByProduct, getSummary, NON_SALE_STATUSES } from './analytics.service';
import { syncOzonOrders } from './sync.service';
import { getTaxRatePct } from '../handlers/taxSettings';
import { ALMATY_TZ, almatyEndOfDay, almatyNow, almatyStartOfDay } from '../utils/timezone';
import { DEFAULT_MODEL } from './assistant.service';

/**
 * «Озон-менеджер» — отдельный Telegram-бот владельца: продажи и маржа за день/период, что отгрузить
 * (сроки FBS, чтобы не было штрафа), сколько денег нужно на закупку товара под заказы, возвраты,
 * остатки на складах Ozon (FBO). Данные — Ozon Seller API и наша база (себестоимость, комиссии).
 */

const money = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ')} ₸`;
const esc = (v: string) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtTime = (iso: string | null) => (iso ? dayjs(iso).tz(ALMATY_TZ).format('DD.MM HH:mm') : '—');

/** Статусы FBS, которые мы ещё не передали Ozon (нужно собрать / отгрузить). */
export const FBS_TO_SHIP = ['awaiting_registration', 'acceptance_in_progress', 'awaiting_approve', 'awaiting_packaging', 'awaiting_deliver'];
/** Под эти отправления товар ещё нужно собрать (а значит, иметь/закупить). */
const FBS_TO_PACK = ['awaiting_registration', 'acceptance_in_progress', 'awaiting_approve', 'awaiting_packaging'];

function dayBounds(dateStr?: string) {
  const d = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : almatyNow().format('YYYY-MM-DD');
  return { date: d, from: almatyStartOfDay(d), to: almatyEndOfDay(d) };
}

async function costByOffer(offerIds: string[]): Promise<Map<string, { cost: number; name: string }>> {
  const ids = [...new Set(offerIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await prisma.product.findMany({
    where: { OR: [{ ozonOfferId: { in: ids } }, { sku: { in: ids } }] },
    select: { sku: true, ozonOfferId: true, costPrice: true, packagingCost: true, name: true },
  });
  const m = new Map<string, { cost: number; name: string }>();
  for (const r of rows) {
    const v = { cost: (r.costPrice || 0) + (r.packagingCost || 0), name: r.name };
    if (r.ozonOfferId) m.set(r.ozonOfferId, v);
    if (!m.has(r.sku)) m.set(r.sku, v);
  }
  return m;
}

// ---------------------------------------------------------------- данные (инструменты бота)

/** Отгрузки FBS: просроченные, сегодня, завтра, позже — по сроку shipment_date. */
export async function fbsToShip() {
  const now = new Date();
  const posts = await ozonClient.fetchFbsPostings(dayjs(now).subtract(30, 'day').toDate(), dayjs(now).add(1, 'day').toDate());
  const open = posts.filter((p) => FBS_TO_SHIP.includes(p.status));
  const todayEnd = almatyEndOfDay(almatyNow().format('YYYY-MM-DD'));
  const tomorrowEnd = dayjs(todayEnd).add(1, 'day').toDate();
  const bucket = (p: { shipmentDate: string | null }) => {
    if (!p.shipmentDate) return 'later';
    const t = new Date(p.shipmentDate);
    if (t < now) return 'overdue';
    if (t <= todayEnd) return 'today';
    if (t <= tomorrowEnd) return 'tomorrow';
    return 'later';
  };
  const list = open
    .map((p) => ({
      postingNumber: p.postingNumber, status: p.status, shipBy: p.shipmentDate, bucket: bucket(p),
      needPacking: FBS_TO_PACK.includes(p.status),
      items: p.products.map((x) => ({ offerId: x.offerId, name: x.name, qty: x.quantity, price: x.price })),
    }))
    .sort((a, b) => String(a.shipBy).localeCompare(String(b.shipBy)));
  const count = (b: string) => list.filter((x) => x.bucket === b).length;
  return { total: list.length, overdue: count('overdue'), today: count('today'), tomorrow: count('tomorrow'), later: count('later'), postings: list };
}

/** Закупка под заказы FBS, которые ещё не собраны: сколько штук каждого товара и сколько денег по закупочной цене. */
export async function purchaseNeeds() {
  const ship = await fbsToShip();
  const need = new Map<string, { offerId: string; name: string; qty: number; postings: number }>();
  for (const p of ship.postings.filter((x) => x.needPacking)) {
    for (const it of p.items) {
      const cur = need.get(it.offerId) ?? { offerId: it.offerId, name: it.name, qty: 0, postings: 0 };
      cur.qty += it.qty; cur.postings += 1;
      need.set(it.offerId, cur);
    }
  }
  const costs = await costByOffer([...need.keys()]);
  let total = 0;
  const items = [...need.values()].map((n) => {
    const c = costs.get(n.offerId);
    const unitCost = c?.cost ?? 0;
    total += unitCost * n.qty;
    return { ...n, unitCost, sum: unitCost * n.qty, noCost: !unitCost };
  }).sort((a, b) => b.sum - a.sum);
  return { totalPurchase: total, positions: items.length, missingCost: items.filter((i) => i.noCost).map((i) => i.offerId), items };
}

/** Продажи за день: FBS из нашей базы (с комиссиями Ozon и себестоимостью) + FBO напрямую из Ozon. */
export async function daySales(dateStr?: string, opts: { sync?: boolean } = {}) {
  const { date, from, to } = dayBounds(dateStr);
  if (opts.sync !== false) {
    try { await syncOzonOrders(dayjs(from).subtract(1, 'day').toDate(), to); } catch (err) { logger.warn({ err }, '[OzonBot] синхронизация заказов не удалась'); }
  }
  const orders = await prisma.order.findMany({
    where: { marketplace: 'OZON', orderDate: { gte: from, lte: to } },
    include: { items: true },
    orderBy: { orderDate: 'asc' },
  });
  const sold = orders.filter((o) => !NON_SALE_STATUSES.includes(o.status));
  const fbs = sold.map((o) => {
    const cogs = o.items.reduce((s, i) => s + i.costPrice * i.quantity, 0);
    const fees = o.marketplaceCommission + o.logisticsCost + o.acquiringCost + o.otherFees;
    const profit = o.totalRevenue - cogs - fees;
    return {
      posting: o.externalId, status: o.status, revenue: o.totalRevenue, cogs, fees, profit,
      feesPending: o.marketplaceCommission === 0, noCost: o.items.some((i) => !i.costPrice),
      items: o.items.map((i) => `${i.name} ×${i.quantity}`),
    };
  });
  let fbo: { revenue: number; cogs: number; count: number; items: { name: string; qty: number; price: number }[]; error?: string } = { revenue: 0, cogs: 0, count: 0, items: [] };
  try {
    const rows = (await ozonClient.fetchFboPostings(from, to)).filter((r) => !/cancel/i.test(r.status));
    const costs = await costByOffer(rows.map((r) => r.offerId));
    fbo = {
      revenue: rows.reduce((s, r) => s + r.price * r.quantity, 0),
      cogs: rows.reduce((s, r) => s + (costs.get(r.offerId)?.cost ?? 0) * r.quantity, 0),
      count: new Set(rows.map((r) => r.postingNumber)).size,
      items: rows.map((r) => ({ name: r.name, qty: r.quantity, price: r.price })),
    };
  } catch (err: any) {
    fbo.error = String(err?.message ?? err).slice(0, 200);
  }
  const revenue = fbs.reduce((s, x) => s + x.revenue, 0);
  const profit = fbs.reduce((s, x) => s + x.profit, 0);
  return {
    date,
    fbs: { orders: fbs.length, revenue, cogs: fbs.reduce((s, x) => s + x.cogs, 0), fees: fbs.reduce((s, x) => s + x.fees, 0), profit, list: fbs },
    fbo,
    cancelled: orders.length - sold.length,
  };
}

/** Итог за период по Ozon (FBS): выручка, себестоимость, комиссии, логистика, налог, чистая прибыль, маржа, топ товаров. */
export async function periodReport(fromStr: string, toStr: string) {
  const from = almatyStartOfDay(fromStr);
  const to = almatyEndOfDay(toStr);
  const tax = await getTaxRatePct();
  const summary = await getSummary({ from, to, marketplace: 'OZON' }, tax);
  const byProduct: any[] = await getByProduct({ from, to, marketplace: 'OZON' }, tax).catch(() => []);
  const rows = Array.isArray(byProduct) ? byProduct : (byProduct as any)?.items ?? [];
  const prof = (r: any) => Number(r.netProfit ?? r.profit ?? 0);
  const sorted = [...rows].sort((a, b) => prof(b) - prof(a));
  const pick = (r: any) => ({ name: r.name, qty: r.quantity, revenue: Math.round(r.revenue ?? 0), profit: Math.round(prof(r)) });
  return {
    from: fromStr, to: toStr, summary,
    topProfit: sorted.slice(0, 5).map(pick),
    worst: sorted.filter((r) => prof(r) < 0).slice(-5).map(pick),
  };
}

/** Возвраты Ozon за N дней: где сейчас, причина, сумма. */
export async function returnsList(days = 7) {
  const rows = await ozonClient.fetchReturns(dayjs().subtract(days, 'day').toDate(), new Date());
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status || '—'] = (byStatus[r.status || '—'] ?? 0) + 1;
  return {
    days, count: rows.length, sum: rows.reduce((s, r) => s + r.price * r.quantity, 0), byStatus,
    items: rows.slice(0, 40).map((r) => ({
      posting: r.postingNumber, schema: r.schema, status: r.status, reason: r.reason, product: r.productName,
      qty: r.quantity, price: r.price, place: r.placeName, changedAt: r.statusChangedAt,
    })),
  };
}

/** Остатки на складах Ozon (FBO) и на сколько дней хватит при продажах за 14 дней. */
export async function fboStock() {
  const stocks = await ozonClient.fetchFboStocks();
  const by = new Map<string, { offerId: string; name: string; free: number }>();
  for (const s of stocks) {
    const cur = by.get(s.offerId) ?? { offerId: s.offerId, name: s.name, free: 0 };
    cur.free += s.free;
    by.set(s.offerId, cur);
  }
  const sales = await ozonClient.fetchFboPostings(dayjs().subtract(14, 'day').toDate(), new Date()).catch(() => []);
  const sold = new Map<string, number>();
  for (const r of sales) if (!/cancel/i.test(r.status)) sold.set(r.offerId, (sold.get(r.offerId) ?? 0) + r.quantity);
  const items = [...by.values()].map((x) => {
    const perDay = (sold.get(x.offerId) ?? 0) / 14;
    return { ...x, sold14: sold.get(x.offerId) ?? 0, daysLeft: perDay > 0 ? Math.floor(x.free / perDay) : null };
  });
  const low = items.filter((x) => x.daysLeft !== null && x.daysLeft <= 7).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  return { skus: items.length, totalFree: items.reduce((s, x) => s + x.free, 0), lowCount: low.length, low: low.slice(0, 20), outOfStockSelling: items.filter((x) => x.free === 0 && x.sold14 > 0).map((x) => x.name).slice(0, 20) };
}

// ---------------------------------------------------------------- готовые отчёты (утро / вечер)

function shipLines(ship: Awaited<ReturnType<typeof fbsToShip>>, buckets: string[], limit = 12) {
  return ship.postings.filter((p) => buckets.includes(p.bucket)).slice(0, limit)
    .map((p) => `• ${esc(p.postingNumber)} — до ${fmtTime(p.shipBy)}${p.needPacking ? ' (не собран)' : ' (собран, сдать)'}: ${esc(p.items.map((i) => `${i.name} ×${i.qty}`).join(', ').slice(0, 120))}`);
}

export async function morningReport(): Promise<string> {
  const out: string[] = [`☀️ <b>Озон — утро, ${almatyNow().format('DD.MM')}</b>`];
  try {
    const ship = await fbsToShip();
    out.push('', `📦 <b>Отгрузка FBS</b>: всего ${ship.total}`);
    if (ship.overdue) out.push(`🔴 <b>Просрочено: ${ship.overdue}</b> — отгрузите как можно скорее, иначе штраф Ozon`);
    out.push(`Сегодня до конца дня: <b>${ship.today}</b> · завтра: ${ship.tomorrow}`);
    out.push(...shipLines(ship, ['overdue', 'today']));
    const buy = await purchaseNeeds();
    out.push('', `🛒 <b>Закупка под заказы</b>: ${money(buy.totalPurchase)} по закупочной цене (${buy.positions} поз.)`);
    out.push(...buy.items.slice(0, 10).map((i) => `• ${esc(i.name.slice(0, 60))} — ${i.qty} шт × ${i.unitCost ? money(i.unitCost) : '<i>нет закупочной цены</i>'}`));
    if (buy.missingCost.length) out.push(`⚠️ Нет закупочной цены у ${buy.missingCost.length} товаров — сумма закупки неполная (заполните в «Товарах»)`);
    if (buy.items.length) out.push('📸 /collect — те же товары фотографиями с количеством, чтобы показать оптовикам');
  } catch (err: any) {
    out.push('', `⚠️ Отгрузки/закупка: не получилось спросить Ozon (${esc(String(err?.message ?? err).slice(0, 120))})`);
  }
  try {
    const ret = await returnsList(1);
    out.push('', `↩️ <b>Возвраты за сутки</b>: ${ret.count}${ret.count ? ` на ${money(ret.sum)}` : ''}`);
    out.push(...ret.items.slice(0, 5).map((r) => `• ${esc(r.product.slice(0, 50))} — ${esc(r.status)}${r.reason ? `, ${esc(r.reason)}` : ''}`));
  } catch { /* возвраты необязательны */ }
  try {
    const st = await fboStock();
    if (st.lowCount || st.outOfStockSelling.length) {
      out.push('', `🏬 <b>Склады Ozon (FBO)</b>: кончается ${st.lowCount} товаров`);
      out.push(...st.low.slice(0, 6).map((x) => `• ${esc(x.name.slice(0, 50))} — ${x.free} шт, ~${x.daysLeft} дн.`));
      if (st.outOfStockSelling.length) out.push(`Закончились (а продавались): ${esc(st.outOfStockSelling.slice(0, 5).join(', '))}`);
    }
  } catch { /* FBO может быть не подключён */ }
  out.push('', 'Спросите меня что угодно про Озон — отвечу 🙂');
  return out.join('\n');
}

export async function eveningReport(): Promise<string> {
  const out: string[] = [`🌙 <b>Озон — итог дня, ${almatyNow().format('DD.MM')}</b>`];
  try {
    const d = await daySales();
    const margin = d.fbs.revenue ? Math.round((d.fbs.profit / d.fbs.revenue) * 100) : 0;
    out.push('', `🧾 <b>FBS</b>: ${d.fbs.orders} заказов на ${money(d.fbs.revenue)}`);
    out.push(`Закупка ${money(d.fbs.cogs)} · комиссии и логистика ${money(d.fbs.fees)}`);
    out.push(`<b>Прибыль ≈ ${money(d.fbs.profit)}</b> (маржа ${margin}%)`);
    if (d.fbs.list.some((x) => x.feesPending)) out.push('<i>По части заказов Ozon ещё не начислил комиссию — прибыль уточнится</i>');
    if (d.fbs.list.some((x) => x.noCost)) out.push('⚠️ В части заказов нет закупочной цены — прибыль завышена');
    if (d.fbo.count || d.fbo.revenue) out.push('', `🏬 <b>FBO</b>: ${d.fbo.count} отправлений на ${money(d.fbo.revenue)}, закупка ${money(d.fbo.cogs)} (комиссия FBO не учтена)`);
    if (d.cancelled) out.push(`❌ Отмен: ${d.cancelled}`);
  } catch (err: any) {
    out.push('', `⚠️ Продажи: ${esc(String(err?.message ?? err).slice(0, 150))}`);
  }
  try {
    const ship = await fbsToShip();
    if (ship.overdue) out.push('', `🔴 <b>Не отгружено и просрочено: ${ship.overdue}</b> — срочно, иначе штраф`);
    out.push(`📦 Завтра отгрузить: ${ship.tomorrow}${ship.today ? `, ещё сегодня: ${ship.today}` : ''}`);
  } catch { /* ignore */ }
  try {
    const ret = await returnsList(1);
    if (ret.count) out.push(`↩️ Возвратов за сутки: ${ret.count} на ${money(ret.sum)}`);
  } catch { /* ignore */ }
  return out.join('\n');
}

// ---------------------------------------------------------------- карточки с фото (для оптовиков)

export type PhotoCard = { offerId: string; name: string; qty: number; photo: string | null };

/** Первое фото товара: витрина My Market, иначе фото с площадки. */
async function photosByOffer(offerIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(offerIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await prisma.product.findMany({
    where: { OR: [{ ozonOfferId: { in: ids } }, { sku: { in: ids } }] },
    select: { sku: true, ozonOfferId: true, images: true, marketImages: true },
  });
  const first = (json: string | null) => {
    try { const a = JSON.parse(json ?? '[]'); return Array.isArray(a) ? a.find((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u)) ?? null : null; } catch { return null; }
  };
  const m = new Map<string, string>();
  for (const r of rows) {
    const url = first(r.images) ?? first(r.marketImages);
    if (!url) continue;
    if (r.ozonOfferId) m.set(r.ozonOfferId, url);
    if (!m.has(r.sku)) m.set(r.sku, url);
  }
  return m;
}

/**
 * Товары одной картинкой на позицию: «collect» — что собрать у оптовиков (несобранные FBS-заказы),
 * «sold» — что продалось за день (FBS + FBO). Одинаковые товары сложены в одну строку с общим количеством.
 */
export async function photoCards(kind: 'collect' | 'sold', dateStr?: string): Promise<{ title: string; cards: PhotoCard[] }> {
  const agg = new Map<string, { offerId: string; name: string; qty: number }>();
  const add = (offerId: string, name: string, qty: number) => {
    const key = offerId || name;
    const cur = agg.get(key) ?? { offerId, name, qty: 0 };
    cur.qty += qty;
    agg.set(key, cur);
  };
  let title: string;
  if (kind === 'collect') {
    const need = await purchaseNeeds();
    for (const i of need.items) add(i.offerId, i.name, i.qty);
    title = '🛒 Собрать у оптовиков (несобранные заказы FBS)';
  } else {
    const { date, from, to } = dayBounds(dateStr);
    try { await syncOzonOrders(dayjs(from).subtract(1, 'day').toDate(), to); } catch { /* берём что есть в базе */ }
    const orders = await prisma.order.findMany({ where: { marketplace: 'OZON', orderDate: { gte: from, lte: to } }, include: { items: true } });
    for (const o of orders.filter((x) => !NON_SALE_STATUSES.includes(x.status))) for (const i of o.items) add(i.externalSku, i.name, i.quantity);
    try {
      for (const r of await ozonClient.fetchFboPostings(from, to)) if (!/cancel/i.test(r.status)) add(r.offerId, r.name, r.quantity);
    } catch { /* FBO может быть не подключён */ }
    title = `📦 Продано ${dayjs(date).format('DD.MM')} (FBS + FBO)`;
  }
  const photos = await photosByOffer([...agg.values()].map((x) => x.offerId));
  const cards = [...agg.values()].sort((a, b) => b.qty - a.qty).map((x) => ({ ...x, photo: photos.get(x.offerId) ?? null }));
  return { title, cards };
}

/** Кто отправляет фото в чат — задаёт Telegram-модуль бота (сервис о Telegram не знает). */
type PhotoSender = (chatId: string, title: string, cards: PhotoCard[]) => Promise<void>;
let photoSender: PhotoSender | null = null;
export function setOzonBotPhotoSender(fn: PhotoSender | null) { photoSender = fn; }

// ---------------------------------------------------------------- «мозг»: Claude с инструментами

export const OZON_TOOLS = [
  { name: 'day_sales', description: 'Продажи Ozon за день (по умолчанию сегодня, Алматы): FBS-заказы с выручкой, закупкой, комиссиями Ozon, прибылью по каждому; FBO-продажи; отмены.', input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, пусто — сегодня' } } } },
  { name: 'period_report', description: 'Юнит-экономика Ozon за период: выручка, закупка, комиссии, логистика, реклама, налог, чистая прибыль, маржа, ROI, лучшие и убыточные товары.', input_schema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['from', 'to'] } },
  { name: 'fbs_to_ship', description: 'Что нужно собрать и отгрузить по FBS и до какого времени (просроченные — штраф), по каждому отправлению.', input_schema: { type: 'object', properties: {} } },
  { name: 'purchase_needs', description: 'Сколько товара и денег по закупочной (оптовой) цене нужно, чтобы собрать ещё не собранные FBS-заказы.', input_schema: { type: 'object', properties: {} } },
  { name: 'returns', description: 'Возвраты Ozon за последние N дней: статус, причина, где сейчас, сумма.', input_schema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'fbo_stock', description: 'Остатки на складах Ozon (FBO) и на сколько дней хватит; что заканчивается.', input_schema: { type: 'object', properties: {} } },
  { name: 'show_photos', description: 'Отправить в чат товары ФОТОГРАФИЯМИ с количеством (одно фото на товар, одинаковые сложены): kind=collect — что собрать у оптовиков под несобранные заказы; kind=sold — что продалось за день. Используй, когда просят «покажи с фото», «что собрать у оптовиков», «какие товары продались». После вызова фото уже в чате — напиши только короткий итог.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['collect', 'sold'] }, date: { type: 'string', description: 'YYYY-MM-DD для sold, пусто — сегодня' } }, required: ['kind'] } },
] as const;

export async function runTool(name: string, input: any, ctx: { chatId?: string } = {}): Promise<unknown> {
  switch (name) {
    case 'show_photos': {
      const { title, cards } = await photoCards(input?.kind === 'sold' ? 'sold' : 'collect', input?.date);
      if (!ctx.chatId || !photoSender) return { error: 'фото сейчас отправить нельзя', cards };
      await photoSender(ctx.chatId, title, cards);
      return { sent: true, positions: cards.length, totalQty: cards.reduce((s, c) => s + c.qty, 0), withoutPhoto: cards.filter((c) => !c.photo).map((c) => c.name) };
    }
    case 'day_sales': return daySales(input?.date);
    case 'period_report': return periodReport(String(input?.from ?? ''), String(input?.to ?? ''));
    case 'fbs_to_ship': return fbsToShip();
    case 'purchase_needs': return purchaseNeeds();
    case 'returns': return returnsList(Math.min(Math.max(Number(input?.days) || 7, 1), 60));
    case 'fbo_stock': return fboStock();
    default: return { error: `нет инструмента ${name}` };
  }
}

function systemPrompt() {
  const now = almatyNow();
  return [
    'Ты — Озон-менеджер интернет-магазина ИП Тушкеев (Алматы, Казахстан). Пишешь владельцу в Telegram.',
    `Сейчас ${now.format('YYYY-MM-DD HH:mm')} по Алматы, валюта — тенге (₸).`,
    'Магазин продаёт на Ozon по FBS (свой склад: сами собираем и отгружаем) и FBO (склад Ozon).',
    'Твоя работа: продажи и маржа, что и до какого срока отгрузить (просрочка = штраф Ozon), сколько денег нужно на закупку товара по оптовой цене, возвраты, остатки FBO.',
    'Всегда бери цифры только из инструментов, ничего не выдумывай. Если данных нет или в них пометка (нет закупочной цены, комиссия ещё не начислена) — прямо скажи.',
    'Отвечай по-русски, коротко и по делу, как опытный менеджер: сначала главное (цифры, срочное), потом детали и совет, что сделать.',
    'Формат — Telegram HTML: только <b>, <i>, переносы строк и «•» для списков. Никакого Markdown (**, #, таблиц).',
    '',
    'АНАЛИЗ КОНКУРЕНТОВ. Если владелец прислал товар (название, фото, себестоимость) и просит оценить — работай как топовый продажник Ozon:',
    '1) Определи товар (по фото и тексту): что это, ключевые характеристики, как его ищут покупатели.',
    '2) Через web_search найди ~10 конкурентов на Ozon Казахстан (ozon.kz; если там мало — ozon.ru): цена, рейтинг и число отзывов, продавец, FBO (доставка со склада Ozon, быстрая) или FBS (со склада продавца, дольше), срок доставки в Алматы.',
    '3) Посчитай нашу юнит-экономику на 1 шт: цена продажи (ориентир — медиана/нижняя треть конкурентов), себестоимость, комиссия Ozon (оценка по категории), логистика, налог 4% от цены, прибыль и маржа. Где цифра — оценка, так и пиши «≈».',
    '4) Вывод: можем ли конкурировать, по какой цене входить, FBO или FBS и почему (FBO — быстрее доставка и выше в выдаче, но платное хранение и поставка на склад Ozon; FBS — гибче, меньше денег в товаре), на какой склад Ozon везти (ближе к Алматы/Астане), сколько штук на старт, что сделать с карточкой (фото, название, отзывы).',
    'Честно указывай, что данные о конкурентах — с публичных страниц Ozon и могут быть неполными. Если web_search недоступен — скажи, что конкурентов посмотреть не могу, и дай расчёт по введённым данным.',
  ].join('\n');
}

type Block = { type: string; [k: string]: any };
type Msg = { role: 'user' | 'assistant'; content: string | Block[] };

let fetchImpl: typeof fetch = (...a) => fetch(...a);
export function setOzonBotFetch(f: typeof fetch | null) { fetchImpl = f ?? ((...a) => fetch(...a)); }

/** Поиск в интернете (сервер Anthropic) — для анализа конкурентов на Ozon. Выключить: OZON_BOT_WEB_SEARCH=off. */
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 6, allowed_domains: ['ozon.kz', 'ozon.ru'] };

export type OzonBotImage = { mediaType: string; base64: string };

/** Ответ на вопрос владельца: Claude сам вызывает инструменты (до 8 шагов) и пишет ответ. Фото товара — для анализа конкурентов. */
export async function askOzonManager(history: Msg[], question: string, image?: OzonBotImage, ctx: { chatId?: string } = {}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 'Мозг бота не подключён: нет ANTHROPIC_API_KEY в Vercel.';
  // Модели по очереди: если аккаунту Anthropic какая-то недоступна (not_found) — берём следующую.
  // Последняя — та же, на которой уже работает Баурсак.
  const models = [...new Set([process.env.OZON_BOT_MODEL, 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', DEFAULT_MODEL].filter(Boolean) as string[])];
  let model = models.shift()!;
  let webSearch = (process.env.OZON_BOT_WEB_SEARCH ?? 'on').toLowerCase() !== 'off';
  const userContent: string | Block[] = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } }, { type: 'text', text: question || 'Проанализируй этот товар для Ozon.' }]
    : question;
  const messages: Msg[] = [...history, { role: 'user', content: userContent }];
  for (let step = 0; step < 8; step++) {
    const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2500, system: systemPrompt(), tools: webSearch ? [...OZON_TOOLS, WEB_SEARCH_TOOL] : OZON_TOOLS, messages }),
    });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Поиск в интернете не включён у аккаунта Anthropic — продолжаем без него.
      if (webSearch && /web.?search/i.test(String(body?.error?.message ?? ''))) { webSearch = false; step--; continue; }
      if ((body?.error?.type === 'not_found_error' || /^model:/i.test(String(body?.error?.message ?? ''))) && models.length) {
        logger.warn({ model }, '[OzonBot] модель недоступна — пробую следующую');
        model = models.shift()!; step--; continue;
      }
      logger.error({ status: r.status, err: body?.error }, '[OzonBot] Claude ответил ошибкой');
      return `Не получилось подумать (${body?.error?.message ?? r.status}). Попробуйте ещё раз.`;
    }
    const content: Block[] = body.content ?? [];
    // Долгий поиск: Anthropic просит продолжить тот же ход.
    if (body.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content }); continue; }
    const calls = content.filter((b) => b.type === 'tool_use');
    if (!calls.length || body.stop_reason !== 'tool_use') {
      return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || 'Готово.';
    }
    messages.push({ role: 'assistant', content });
    const results: Block[] = [];
    for (const c of calls) {
      let out: unknown;
      try { out = await runTool(c.name, c.input, ctx); } catch (err: any) { out = { error: String(err?.message ?? err).slice(0, 300) }; }
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out).slice(0, 30000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Слишком сложный вопрос — давайте по частям.';
}
