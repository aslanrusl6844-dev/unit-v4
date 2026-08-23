export type MarketplaceName = 'KASPI' | 'OZON' | 'WB';

// Единый нормализованный формат заказа, к которому мы приводим данные
// из Kaspi и Ozon перед сохранением в БД. Это позволяет считать юнит-экономику
// одинаково для обеих площадок.
export interface NormalizedOrderItem {
  externalSku: string;
  name: string;
  quantity: number;
  price: number; // цена за единицу
  // Категория и вес позиции — приходят от Kaspi (не у всех площадок есть).
  // Категория здесь LEAF-уровня (например, "Зонты"), не совпадает по
  // формату с верхнеуровневой таблицей ставок — используется как
  // kaspiLeafCategory, для более точного расчёта комиссии (LEAF_OVERRIDES).
  kaspiLeafCategory?: string;
  weightG?: number; // вес в граммах, если известен
}

export interface NormalizedOrder {
  externalId: string;
  marketplace: MarketplaceName;
  status: string;
  orderDate: Date;
  deliveryType?: string;
  city?: string;
  totalRevenue: number;
  marketplaceCommission: number;
  logisticsCost: number;
  acquiringCost: number;
  otherFees: number;
  items: NormalizedOrderItem[];
  raw?: unknown;
  /** Только для Kaspi: доставлялся ли заказ через Kaspi Доставку (влияет на логистику) */
  kaspiDelivery?: boolean;
  /** Только для Kaspi: внутренний id заказа (отличается от externalId/code), нужен для API-запросов на изменение статуса */
  kaspiInternalId?: string;
}

export interface UnitEconomicsSummary {
  ordersCount: number;
  itemsCount: number;
  revenue: number;
  cogs: number;
  marketplaceCommission: number;
  logisticsCost: number;
  acquiringCost: number;
  otherFees: number;
  adSpend: number;
  manualExpenses: number;
  grossProfit: number; // revenue - cogs
  netProfit: number; // revenue - cogs - все удержания и расходы = "прибыль ДО налога"
  marginPct: number; // netProfit / revenue * 100
  roiPct: number; // netProfit / (cogs + все расходы) * 100
  aov: number; // средний чек = revenue / ordersCount
  taxRatePct: number; // ставка налога ИП, %
  taxAmount: number; // налог = revenue * taxRatePct / 100 (НЕ от прибыли)
  payout: number; // "к выводу" = netProfit - taxAmount
}
