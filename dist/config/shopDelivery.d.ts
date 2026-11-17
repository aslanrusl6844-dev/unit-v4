/**
 * Доставка заказов магазина My Market по Казахстану.
 * Правило из оферты mymarket.kz: при сумме товаров менее 10 000 ₸ доставка 1 000 ₸,
 * при сумме от 10 000 ₸ и более — бесплатно. Меняется здесь и в приложении
 * (ShopConfig.kt: FREE_DELIVERY_FROM / DELIVERY_FEE) одновременно.
 */
export declare const FREE_DELIVERY_FROM = 10000;
export declare const DELIVERY_FEE = 1000;
/** Стоимость доставки по сумме товаров (до бонусов), в тенге. */
export declare function deliveryFeeFor(itemsSubtotal: number): number;
/** Сколько доставки в уже созданном заказе: итог минус сумма позиций (старые заказы — 0). */
export declare function deliveryFeeOfOrder(total: number, items: {
    price?: number;
    quantity?: number;
}[]): number;
