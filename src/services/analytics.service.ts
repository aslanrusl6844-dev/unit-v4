import { prisma } from '../db/prisma';
import { MarketplaceName, UnitEconomicsSummary } from '../types';

interface RangeFilter {
  from: Date;
  to: Date;
  marketplace?: MarketplaceName;
}

function whereClause(filter: RangeFilter) {
  return {
    orderDate: { gte: filter.from, lte: filter.to },
    ...(filter.marketplace ? { marketplace: filter.marketplace } : {}),
  };
}

export async function getSummary(filter: RangeFilter): Promise<UnitEconomicsSummary> {
  const orders = await prisma.order.findMany({
    where: whereClause(filter),
    include: { items: true },
  });

  const adSpendAgg = await prisma.adSpend.aggregate({
    where: {
      date: { gte: filter.from, lte: filter.to },
      ...(filter.marketplace ? { marketplace: filter.marketplace } : {}),
    },
    _sum: { amount: true },
  });

  const manualExpenseAgg = await prisma.manualExpense.aggregate({
    where: {
      date: { gte: filter.from, lte: filter.to },
      ...(filter.marketplace ? { marketplace: filter.marketplace } : {}),
    },
    _sum: { amount: true },
  });

  let revenue = 0;
  let cogs = 0;
  let itemsCount = 0;
  let marketplaceCommission = 0;
  let logisticsCost = 0;
  let acquiringCost = 0;
  let otherFees = 0;

  for (const order of orders) {
    marketplaceCommission += order.marketplaceCommission;
    logisticsCost += order.logisticsCost;
    acquiringCost += order.acquiringCost;
    otherFees += order.otherFees;

    for (const item of order.items) {
      revenue += item.price * item.quantity;
      cogs += item.costPrice * item.quantity;
      itemsCount += item.quantity;
    }
  }

  const adSpend = adSpendAgg._sum.amount ?? 0;
  const manualExpenses = manualExpenseAgg._sum.amount ?? 0;

  const grossProfit = revenue - cogs;
  const totalExpenses = cogs + marketplaceCommission + logisticsCost + acquiringCost + otherFees + adSpend + manualExpenses;
  const netProfit = revenue - totalExpenses;
  const marginPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;
  const roiPct = totalExpenses > 0 ? (netProfit / totalExpenses) * 100 : 0;
  const aov = orders.length > 0 ? revenue / orders.length : 0;

  return {
    ordersCount: orders.length,
    itemsCount,
    revenue: round2(revenue),
    cogs: round2(cogs),
    marketplaceCommission: round2(marketplaceCommission),
    logisticsCost: round2(logisticsCost),
    acquiringCost: round2(acquiringCost),
    otherFees: round2(otherFees),
    adSpend: round2(adSpend),
    manualExpenses: round2(manualExpenses),
    grossProfit: round2(grossProfit),
    netProfit: round2(netProfit),
    marginPct: round2(marginPct),
    roiPct: round2(roiPct),
    aov: round2(aov),
  };
}

export async function getSummaryByMarketplace(filter: Omit<RangeFilter, 'marketplace'>) {
  const [kaspi, ozon, wb, total] = await Promise.all([
    getSummary({ ...filter, marketplace: 'KASPI' }),
    getSummary({ ...filter, marketplace: 'OZON' }),
    getSummary({ ...filter, marketplace: 'WB' }),
    getSummary(filter),
  ]);
  return { kaspi, ozon, wb, total };
}

export async function getByCategory(filter: RangeFilter) {
  const orders = await prisma.order.findMany({
    where: whereClause(filter),
    include: { items: { include: { product: true } } },
  });

  const map = new Map<string, { category: string; quantity: number; revenue: number }>();

  for (const order of orders) {
    for (const item of order.items) {
      const category = item.product?.kaspiTopCategory || 'Без категории';
      const entry = map.get(category) ?? { category, quantity: 0, revenue: 0 };
      entry.quantity += item.quantity;
      entry.revenue += item.price * item.quantity;
      map.set(category, entry);
    }
  }

  return Array.from(map.values())
    .map((e) => ({ ...e, revenue: round2(e.revenue) }))
    .sort((a, b) => b.revenue - a.revenue);
}

export async function getByProduct(filter: RangeFilter) {
  const orders = await prisma.order.findMany({
    where: whereClause(filter),
    include: { items: { include: { product: true } } },
  });

  const map = new Map<
    string,
    { sku: string; name: string; quantity: number; revenue: number; cogs: number; profit: number }
  >();

  for (const order of orders) {
    for (const item of order.items) {
      const key = item.productId ?? item.externalSku;
      const entry = map.get(key) ?? {
        sku: item.product?.sku ?? item.externalSku,
        name: item.name,
        quantity: 0,
        revenue: 0,
        cogs: 0,
        profit: 0,
      };
      const itemRevenue = item.price * item.quantity;
      const itemCogs = item.costPrice * item.quantity;
      entry.quantity += item.quantity;
      entry.revenue += itemRevenue;
      entry.cogs += itemCogs;
      entry.profit += itemRevenue - itemCogs;
      map.set(key, entry);
    }
  }

  return Array.from(map.values())
    .map((e) => ({
      ...e,
      revenue: round2(e.revenue),
      cogs: round2(e.cogs),
      profit: round2(e.profit),
      marginPct: e.revenue > 0 ? round2((e.profit / e.revenue) * 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

export async function getTimeseries(filter: RangeFilter, groupBy: 'day' | 'week' | 'month' = 'day') {
  const orders = await prisma.order.findMany({
    where: whereClause(filter),
    include: { items: true },
    orderBy: { orderDate: 'asc' },
  });

  const bucket = (date: Date): string => {
    const d = new Date(date);
    if (groupBy === 'day') return d.toISOString().slice(0, 10);
    if (groupBy === 'month') return d.toISOString().slice(0, 7);
    // week: понедельник этой недели
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
    return d.toISOString().slice(0, 10);
  };

  const map = new Map<string, { date: string; revenue: number; cogs: number; expenses: number; profit: number; orders: number }>();

  for (const order of orders) {
    const key = bucket(order.orderDate);
    const entry = map.get(key) ?? { date: key, revenue: 0, cogs: 0, expenses: 0, profit: 0, orders: 0 };

    const orderRevenue = order.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const orderCogs = order.items.reduce((s, i) => s + i.costPrice * i.quantity, 0);
    const orderExpenses = order.marketplaceCommission + order.logisticsCost + order.acquiringCost + order.otherFees;

    entry.revenue += orderRevenue;
    entry.cogs += orderCogs;
    entry.expenses += orderExpenses;
    entry.profit += orderRevenue - orderCogs - orderExpenses;
    entry.orders += 1;

    map.set(key, entry);
  }

  return Array.from(map.values())
    .map((e) => ({ ...e, revenue: round2(e.revenue), cogs: round2(e.cogs), expenses: round2(e.expenses), profit: round2(e.profit) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
