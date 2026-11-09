import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { ozonClient, OzonCashFlow } from '../integrations/ozon.client';
import { getTaxRatePct } from '../handlers/taxSettings';

/**
 * Выплаты Ozon и расчёт с оптовиком.
 *
 * 1) refreshOzonAccruals — подтягивает начисления Ozon по уже сохранённым заказам
 *    (/v1/finance/accrual/postings). Начисления появляются ПОСЛЕ доставки, а синхронизация
 *    заказов берёт только свежие отправления — поэтому нужен отдельный проход по заказам,
 *    по которым Ozon ещё ничего не начислил.
 * 2) getOzonPayoutReport — по полке оптовика (или по всему Ozon) за период:
 *    сколько начислено Ozon к выплате, сколько из этого отдать оптовику (оптовые цены),
 *    налог и чистая прибыль; разбивка по периодам выплат Ozon (1–15 и 16–конец месяца);
 *    плюс заказы, по которым Ozon ещё не начислил (ожидается — по тарифам).
 */

const CANCELLED = ['cancelled', 'canceled', 'CANCELLED', 'not_accepted'];
const DAY = 24 * 3600 * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Не чаще раза в 20 минут без force (отметка JobMark), чтобы не упираться в лимиты Ozon. */
export async function refreshOzonAccruals(opts: { force?: boolean } = {}) {
  if (!(await ozonClient.isConfigured())) return { checked: 0, settled: 0, skipped: 'not-configured' };
  if (!opts.force) {
    const since = new Date(Date.now() - 20 * 60 * 1000);
    const claimed = await prisma.$executeRaw`
      INSERT INTO "JobMark" ("id", "lastAt") VALUES ('ozon-accruals', now())
      ON CONFLICT ("id") DO UPDATE SET "lastAt" = now() WHERE "JobMark"."lastAt" < ${since}`;
    if (!claimed) return { checked: 0, settled: 0, skipped: 'recent' };
  }
  // Ещё не начисленные заказы за 90 дней + уже начисленные за последние 20 дней
  // (у них могут добавиться удержания, например обратная логистика при возврате).
  const orders = await prisma.order.findMany({
    where: {
      marketplace: 'OZON',
      status: { notIn: CANCELLED },
      OR: [
        { settledAt: null, orderDate: { gte: new Date(Date.now() - 90 * DAY) } },
        { settledAt: { gte: new Date(Date.now() - 20 * DAY) } },
      ],
    },
    include: { items: true },
    take: 1000,
  });
  if (!orders.length) return { checked: 0, settled: 0 };

  // Статусы старых заказов: синхронизация заказов берёт только последние дни, поэтому
  // заказ месячной давности мог остаться «в пути», хотя давно доставлен или отменён.
  const oldest = orders.reduce((m, o) => (o.orderDate < m ? o.orderDate : m), new Date());
  let statuses = new Map<string, string>();
  try {
    statuses = await ozonClient.fetchPostingStatuses(new Date(oldest.getTime() - DAY), new Date());
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, '[Ozon] Не удалось обновить статусы отправлений');
  }

  const finance = await ozonClient.fetchFinanceForPostings(orders.map((o) => o.externalId));
  let settled = 0;
  for (const o of orders) {
    const status = statuses.get(o.externalId) ?? o.status;
    const f = finance.get(o.externalId);
    if (!f && status === o.status) continue;
    const revenue = o.items.reduce((s, i) => s + i.price * i.quantity, 0) || o.totalRevenue;
    const commission = f?.commission ?? o.marketplaceCommission;
    const logistics = f?.logistics ?? o.logisticsCost;
    const acquiring = f?.acquiring ?? o.acquiringCost;
    const other = f?.other ?? o.otherFees;
    // Продажа засчитана Ozon: доставлен покупателю (есть комиссия за продажу или статус «доставлен»).
    const isSold = status === 'delivered' || !!f?.settledAt;
    const settledAt = isSold ? (f?.settledAt ?? o.settledAt ?? new Date()) : null;
    if (isSold) settled += 1;
    await prisma.$transaction([
      prisma.order.update({
        where: { id: o.id },
        data: {
          status,
          marketplaceCommission: round2(commission),
          logisticsCost: round2(logistics),
          acquiringCost: round2(acquiring),
          otherFees: round2(other),
          settledAt,
          payoutAmount: isSold ? round2(revenue - commission - logistics - acquiring - other) : null,
        },
      }),
      ...o.items.map((i) => {
        const share = revenue > 0 ? (i.price * i.quantity) / revenue : 1 / o.items.length;
        return prisma.orderItem.update({
          where: { id: i.id },
          data: { commission: round2(commission * share), itemLogistics: round2(logistics * share) },
        });
      }),
    ]);
  }
  logger.info(`[Ozon] Начисления: проверено ${orders.length}, с начислениями ${settled}`);
  return { checked: orders.length, settled };
}

/** Периоды выплат Ozon: с 1 по 15 и с 16 по последний день месяца (даты по Алматы, UTC+5). */
export function payoutPeriodOf(d: Date): { key: string; from: string; to: string } {
  const local = new Date(d.getTime() + 5 * 3600 * 1000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const day = local.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const mm = String(m + 1).padStart(2, '0');
  const fromDay = day <= 15 ? 1 : 16;
  const toDay = day <= 15 ? 15 : last;
  const from = `${y}-${mm}-${String(fromDay).padStart(2, '0')}`;
  const to = `${y}-${mm}-${String(toDay).padStart(2, '0')}`;
  return { key: from, from, to };
}

interface Money {
  quantity: number;
  revenue: number;
  commission: number;
  logistics: number;
  otherFees: number;
  payout: number;
  tax: number;
  wholesaler: number;
  net: number;
}
const emptyMoney = (): Money => ({ quantity: 0, revenue: 0, commission: 0, logistics: 0, otherFees: 0, payout: 0, tax: 0, wholesaler: 0, net: 0 });
function addMoney(a: Money, b: Money) {
  (Object.keys(a) as (keyof Money)[]).forEach((k) => { a[k] += b[k]; });
}
function roundMoney(m: Money): Money {
  const out = { ...m };
  (Object.keys(out) as (keyof Money)[]).forEach((k) => { out[k] = round2(out[k]); });
  return out;
}

export async function getOzonPayoutReport(params: { from: Date; to: Date; wholesalerId?: string | null }) {
  const taxRatePct = await getTaxRatePct();

  // Товары полки: у оптовика — его товары на Ozon; '__none__' — товары Ozon без оптовика; пусто — весь Ozon.
  let productIds: Set<string> | null = null;
  if (params.wholesalerId) {
    const assigned = await prisma.wholesalerProduct.findMany({ where: { marketplace: 'OZON' }, select: { productId: true, wholesalerId: true } });
    if (params.wholesalerId === '__none__') {
      const taken = new Set(assigned.map((a) => a.productId));
      const ozonProducts = await prisma.product.findMany({ where: { ozonOfferId: { not: null } }, select: { id: true } });
      productIds = new Set(ozonProducts.map((p) => p.id).filter((id) => !taken.has(id)));
    } else {
      productIds = new Set(assigned.filter((a) => a.wholesalerId === params.wholesalerId).map((a) => a.productId));
    }
  }

  const products = await prisma.product.findMany({
    where: { ozonOfferId: { not: null } },
    select: { id: true, costPrice: true, ozonCommissionRatePct: true, ozonLogisticsAmount: true, ozonLastMileAmount: true },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const orders = await prisma.order.findMany({
    where: {
      marketplace: 'OZON',
      status: { notIn: CANCELLED },
      OR: [
        { settledAt: { gte: params.from, lte: params.to } },
        // Ещё не начисленные Ozon (в пути / ждут доставки) — за 90 дней, независимо от периода.
        { settledAt: null, orderDate: { gte: new Date(Date.now() - 90 * DAY) } },
      ],
    },
    include: { items: true },
    orderBy: { orderDate: 'asc' },
  });

  const settledTotal = emptyMoney();
  const pendingTotal = emptyMoney();
  const periods = new Map<string, { from: string; to: string; money: Money; orders: number }>();
  let pendingOrders = 0;
  let settledOrders = 0;

  for (const o of orders) {
    const lines = o.items.filter((i) => i.productId && (!productIds || productIds.has(i.productId)));
    if (!lines.length) continue;
    const orderRevenue = o.items.reduce((s, i) => s + i.price * i.quantity, 0) || o.totalRevenue || 1;
    const settled = o.settledAt != null;
    const m = emptyMoney();
    for (const i of lines) {
      const p = i.productId ? productById.get(i.productId) : undefined;
      const revenue = i.price * i.quantity;
      const share = revenue / orderRevenue;
      // Оптовику — себестоимость (оптовая цена). Если в заказе её не было (вписали позже) — текущая из карточки.
      const unitCost = i.costPrice > 0 ? i.costPrice : (p?.costPrice ?? 0);
      let commission: number;
      let logistics: number;
      let otherFees: number;
      let payout: number;
      if (settled) {
        commission = o.marketplaceCommission * share;
        logistics = o.logisticsCost * share;
        otherFees = (o.acquiringCost + o.otherFees) * share;
        payout = o.payoutAmount != null ? o.payoutAmount * share : revenue - commission - logistics - otherFees;
      } else {
        // Ozon ещё не засчитал продажу — комиссия и логистика по текущим тарифам товара
        // (или уже начисленные, если больше), плюс уже удержанные штрафы/сборы по заказу.
        commission = Math.max(revenue * ((p?.ozonCommissionRatePct ?? 0) / 100), o.marketplaceCommission * share);
        logistics = Math.max(((p?.ozonLogisticsAmount ?? 0) + (p?.ozonLastMileAmount ?? 0)) * i.quantity, o.logisticsCost * share);
        otherFees = (o.acquiringCost + o.otherFees) * share;
        payout = revenue - commission - logistics - otherFees;
      }
      const tax = revenue * (taxRatePct / 100);
      const wholesaler = unitCost * i.quantity;
      addMoney(m, { quantity: i.quantity, revenue, commission, logistics, otherFees, payout, tax, wholesaler, net: payout - tax - wholesaler });
    }
    if (settled) {
      settledOrders += 1;
      addMoney(settledTotal, m);
      const per = payoutPeriodOf(o.settledAt!);
      const row = periods.get(per.key) ?? { from: per.from, to: per.to, money: emptyMoney(), orders: 0 };
      addMoney(row.money, m);
      row.orders += 1;
      periods.set(per.key, row);
    } else {
      pendingOrders += 1;
      addMoney(pendingTotal, m);
    }
  }

  // Выплаты Ozon по всему магазину (из финансового отчёта Ozon) — сколько реально перечислено за период.
  let cashFlows: OzonCashFlow[] = [];
  let cashFlowsError: string | null = null;
  try {
    cashFlows = await ozonClient.fetchCashFlows(new Date(params.from.getTime() - 16 * DAY), new Date(Math.max(params.to.getTime(), Date.now())));
  } catch (err: any) {
    cashFlowsError = String(err?.response?.data?.message ?? err?.message ?? err);
  }
  let balance: Awaited<ReturnType<typeof ozonClient.fetchBalance>> | null = null;
  try {
    balance = await ozonClient.fetchBalance(new Date(Date.now() - 29 * DAY), new Date());
  } catch { /* баланс — справочно */ }

  return {
    taxRatePct,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    settled: { orders: settledOrders, ...roundMoney(settledTotal) },
    pending: { orders: pendingOrders, ...roundMoney(pendingTotal) },
    periods: Array.from(periods.values())
      .sort((a, b) => b.from.localeCompare(a.from))
      .map((p) => ({ from: p.from, to: p.to, orders: p.orders, ...roundMoney(p.money) })),
    store: {
      cashFlows: cashFlows.map((c) => ({
        begin: c.begin,
        end: c.end,
        accrued: round2(c.ordersAmount + c.returnsAmount + c.commissionAmount + c.servicesAmount + c.deliveryAndReturnAmount),
        orders: round2(c.ordersAmount),
        paid: round2(Math.abs(c.payments)),
        endBalance: c.endBalance,
      })),
      cashFlowsError,
      balance,
    },
  };
}
