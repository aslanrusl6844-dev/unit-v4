/** Регионы Казахстана для Google Trends (коды Google; список можно расширять). */
export declare const TRENDS_REGIONS: Record<string, string>;
declare const MARKETPLACES: readonly ["KASPI", "OZON", "WB", "TEEZ", "APP"];
type Mp = (typeof MARKETPLACES)[number];
export interface MySalesMonth {
    month: string;
    byMarketplace: Partial<Record<Mp, {
        quantity: number;
        revenue: number;
    }>>;
    quantity: number;
    revenue: number;
}
export interface MySalesResult {
    keyword: string;
    from: string;
    to: string;
    months: MySalesMonth[];
    totals: Partial<Record<Mp, {
        quantity: number;
        revenue: number;
    }>> & {
        all: {
            quantity: number;
            revenue: number;
        };
    };
    topProducts: Array<{
        name: string;
        quantity: number;
        revenue: number;
    }>;
    truncated: boolean;
}
/**
 * Продажи ТВОИХ товаров, в названии которых есть слово — по месяцам и площадкам.
 * Считаются только заказы, не входящие в NON_SALE_STATUSES (без отмен и возвратов).
 * Это данные из нашей базы, не оценка.
 */
export declare function getMySalesByKeyword(keyword: string, from: Date, to: Date, db?: {
    orderItem: {
        findMany: (args: any) => Promise<any[]>;
    };
}): Promise<MySalesResult>;
export interface TrendsResult {
    keyword: string;
    geo: string;
    geoLabel: string;
    timeline: Array<{
        date: string;
        value: number;
    }>;
    relatedTop: Array<{
        query: string;
        value: number;
    }>;
    relatedRising: Array<{
        query: string;
        value: string;
    }>;
}
/** Ответ Trends — JSON, но при блокировке приходит HTML; делаем из этого понятную ошибку. */
export declare function parseTrendsJson<T>(raw: string, what: string): T;
export declare function mapTimeline(json: any): TrendsResult['timeline'];
export declare function mapRelated(json: any): {
    top: TrendsResult['relatedTop'];
    rising: TrendsResult['relatedRising'];
};
export declare function getGoogleTrends(keyword: string, geo: string, months: number): Promise<TrendsResult>;
export {};
