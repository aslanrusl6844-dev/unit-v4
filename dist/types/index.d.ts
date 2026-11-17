export type MarketplaceName = 'KASPI' | 'OZON' | 'WB' | 'APP' | 'TEEZ';
export interface NormalizedOrderItem {
    externalSku: string;
    name: string;
    quantity: number;
    price: number;
    kaspiLeafCategory?: string;
    weightG?: number;
    wbSubject?: string;
    wbScheme?: 'FBS' | 'FBW';
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
    /** Ozon: дата начисления продажи (по ней — период выплаты) и сумма к выплате по заказу. */
    settledAt?: Date | null;
    payoutAmount?: number | null;
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
    grossProfit: number;
    netProfit: number;
    marginPct: number;
    roiPct: number;
    aov: number;
    taxRatePct: number;
    taxAmount: number;
    payout: number;
}
