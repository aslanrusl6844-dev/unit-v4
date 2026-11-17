import { MarketplaceName, UnitEconomicsSummary } from '../types';
interface RangeFilter {
    from: Date;
    to: Date;
    marketplace?: MarketplaceName;
}
/**
 * Статусы заказов, которые НЕ считаются продажей: отменённые, отклонённые и
 * возвращённые (Kaspi, Ozon, WB, My Market). Такие заказы остаются в списке
 * «Заказы» (зачёркнутыми), но не попадают в выручку, прибыль, графики и
 * отчёты.
 */
export declare const NON_SALE_STATUSES: string[];
export declare function getSummary(filter: RangeFilter, taxRatePct?: number): Promise<UnitEconomicsSummary>;
export declare function getSummaryByMarketplace(filter: Omit<RangeFilter, 'marketplace'>, taxRatePct?: number): Promise<{
    kaspi: UnitEconomicsSummary;
    ozon: UnitEconomicsSummary;
    wb: UnitEconomicsSummary;
    teez: UnitEconomicsSummary;
    app: UnitEconomicsSummary;
    total: UnitEconomicsSummary;
}>;
export declare function getByCategory(filter: RangeFilter): Promise<{
    revenue: number;
    category: string;
    quantity: number;
}[]>;
export declare function getByProduct(filter: RangeFilter, taxRatePct?: number): Promise<{
    sku: string;
    name: string;
    quantity: number;
    avgPrice: number;
    revenue: number;
    cogs: number;
    commission: number;
    commissionRate: number;
    logistics: number;
    adSpend: number;
    netProfit: number;
    profit: number;
    marginPct: number;
    tax: number;
    taxRatePct: number;
    payout: number;
    marginAfterTaxPct: number;
}[]>;
export declare function getTimeseries(filter: RangeFilter, groupBy?: 'day' | 'week' | 'month'): Promise<{
    revenue: number;
    cogs: number;
    expenses: number;
    profit: number;
    date: string;
    orders: number;
}[]>;
/**
 * ПРОГНОЗНАЯ юнит-экономика по каталогу — ОТДЕЛЬНО ПО КАЖДОЙ ПЛОЩАДКЕ,
 * оценка "если продать по текущей цене прямо сейчас", даже если по
 * товару на этой площадке ещё не было ни одной продажи.
 *
 * У каждой площадки — свои поля цены (kaspiReferencePrice/ozonReferencePrice/
 * wbReferencePrice) и честно РАЗНЫЙ источник оценки комиссии/логистики,
 * потому что у нас нет одинаково надёжных данных по всем трём:
 *
 *  - Kaspi (если указана категория): точный расчёт по официальной
 *    тарифной таблице (та же формула, что при синхронизации заказов) —
 *    это НАСТОЯЩАЯ оценка, не статистика по прошлым продажам, работает
 *    даже с нуля продаж на Kaspi.
 *  - Ozon / WB (и Kaspi без указанной категории): официальных тарифных
 *    таблиц у нас для них нет — поэтому оценка строится по СРЕДНЕЙ
 *    фактической ставке комиссии/логистики (% от цены) из уже
 *    состоявшихся продаж ЭТОГО ЖЕ товара НА ЭТОЙ ЖЕ площадке (ставки не
 *    смешиваются между площадками — у Ozon и WB разные комиссии). Если
 *    продаж на этой площадке вообще не было — честно возвращаем
 *    "нет данных", а не выдуманное число.
 */
export interface ProductForecast {
    productId: string;
    marketplace: MarketplaceName;
    referencePrice: number | null;
    estCommission: number | null;
    estCommissionRate: number | null;
    estLogistics: number | null;
    estProfit: number | null;
    estMarginPct: number | null;
    estTax: number | null;
    estPayout: number | null;
    estMarginAfterTaxPct: number | null;
    estReturnCost: number | null;
    source: 'kaspi-tariff' | 'kaspi-tariff-default' | 'ozon-tariff' | 'wb-tariff' | 'teez-rate' | 'historical-average' | 'no-data';
}
export declare function getProductForecasts(taxRatePct?: number): Promise<ProductForecast[]>;
export {};
