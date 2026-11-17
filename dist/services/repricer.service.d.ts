export interface RepriceResult {
    productId: string;
    sku: string;
    oldPrice: number | null;
    newPrice: number;
    lowestCompetitorPrice: number | null;
    hitFloor: boolean;
    hitCeiling: boolean;
    changed: boolean;
}
export type RepriceStrategy = 'FIRST_PLACE' | 'MATCH_FIRST' | 'STICK_TO_FIRST' | 'SECOND_PLACE';
interface RepriceableProduct {
    id: string;
    sku: string;
    kaspiProductUrl: string | null;
    minPrice: number | null;
    maxPrice: number | null;
    repriceStep: number;
    repriceStrategy: RepriceStrategy;
    currentKaspiPrice: number | null;
}
/**
 * Считает новую цену для одного товара:
 * - находит цены конкурентов на странице;
 * - применяет выбранную стратегию (см. calculateDesiredPrice);
 * - ограничивает результат диапазоном [minPrice, maxPrice] — НИКОГДА не
 *   опускается ниже minPrice (защита от продажи в убыток) и не поднимается
 *   выше maxPrice, если он задан.
 */
export declare function repriceProduct(product: RepriceableProduct): Promise<RepriceResult | null>;
/** Прогоняет автобот по всем товарам, у которых включён autoRepriceEnabled. */
export declare function runRepricingCycle(): Promise<RepriceResult[]>;
export {};
