import { NormalizedOrder } from '../types';
/**
 * В Teez одна строка API = одна товарная позиция. Если в заказе несколько
 * позиций, они приходят строками с одним номером — склеиваем в один заказ,
 * иначе каждая следующая затёрла бы предыдущую.
 */
export declare function mergeTeezOrders(orders: NormalizedOrder[]): NormalizedOrder[];
export declare function syncTeezOrders(dateFrom: Date, dateTo: Date): Promise<{
    ordersProcessed: number;
    productsCreated: number;
    unmatchedItems: number;
}>;
/**
 * Каталог Teez → «Товары»: список товаров + детали (SKU, штрихкод, цена, фото).
 * Товар учёта ищем по штрихкоду Teez (teezSku), затем по совпадающему артикулу
 * (sku / Kaspi / Ozon / WB), затем по точному названию; не нашли — создаём новый
 * (себестоимость 0 — её надо вписать). Остаток берём из списка товаров Teez.
 */
export declare function syncTeezCatalog(): Promise<{
    total: number;
    created: number;
    updated: number;
    skipped: "not-configured";
} | {
    total: number;
    created: number;
    updated: number;
    skipped?: undefined;
}>;
