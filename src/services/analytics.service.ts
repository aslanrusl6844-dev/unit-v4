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

  const adSpendAgg = await prisma.adSpend.aggregate({
    where: {
      date: { gte: filter.from, lte: filter.to },
      ...(filter.marketplace ? { marketplace: filter.marketplace } : {}),
    },
    _sum: { amount: true },
  });
  const totalAdSpend = adSpendAgg._sum.amount ?? 0;

  const map = new Map<
    string,
    {
      sku: string;
      name: string;
      quantity: number;
      avgPrice: number;
      revenue: number;
      cogs: number;
      commission: number;
      logistics: number;
    }
  >();

  let grandTotalRevenue = 0;

  for (const order of orders) {
    for (const item of order.items) {
      const key = item.productId ?? item.externalSku;
      const entry = map.get(key) ?? {
        sku: item.product?.sku ?? item.externalSku,
        name: item.name,
        quantity: 0,
        avgPrice: 0,
        revenue: 0,
        cogs: 0,
        commission: 0,
        logistics: 0,
      };
      const itemRevenue = item.price * item.quantity;
      const itemCogs = item.costPrice * item.quantity;
      // commission/itemLogistics уже точно посчитаны и сохранены на уровне
      // позиции в момент синхронизации (см. sync.service.ts) — здесь просто
      // суммируем готовые значения, никакой пропорции/восстановления задним
      // числом больше не нужно.
      entry.quantity += item.quantity;
      entry.revenue += itemRevenue;
      entry.cogs += itemCogs;
      entry.commission += item.commission;
      entry.logistics += item.itemLogistics;
      grandTotalRevenue += itemRevenue;
      map.set(key, entry);
    }
  }

  // Реклама распределяется между товарами ПРОПОРЦИОНАЛЬНО ВЫРУЧКЕ (не
  // количеству штук) — так честнее экономически: товар, который принёс
  // больше денег, "нёс" на себе и больше рекламного бюджета, независимо от
  // того, сколько единиц было продано. Дешёвый товар, проданный много раз
  // на ту же сумму, что и дорогой — один раз, получит одинаковую долю
  // рекламы, что и отражает реальный вклад в оборот.
  return Array.from(map.values())
    .map((e) => {
      const adSpendShare = grandTotalRevenue > 0 ? (e.revenue / grandTotalRevenue) * totalAdSpend : 0;
      const netProfit = e.revenue - e.cogs - e.commission - e.logistics - adSpendShare;
      return {
        sku: e.sku,
        name: e.name,
        quantity: e.quantity,
        avgPrice: e.quantity > 0 ? round2(e.revenue / e.quantity) : 0,
        revenue: round2(e.revenue),
        cogs: round2(e.cogs),
        commission: round2(e.commission),
        logistics: round2(e.logistics),
        adSpend: round2(adSpendShare),
        netProfit: round2(netProfit),
        // profit — оставлен для обратной совместимости с местами, которые
        // уже используют это поле (Обзор, старая версия таблицы товаров);
        // значение то же самое, что netProfit.
        profit: round2(netProfit),
        marginPct: e.revenue > 0 ? round2((netProfit / e.revenue) * 100) : 0,
      };
    })
    .sort((a, b) => b.netProfit - a.netProfit);
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
