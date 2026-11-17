/**
 * Оптовики раздела «Товары» (Kaspi / Ozon / WB): полки товаров по оптовикам.
 * Модель Product, синхронизация и расчёт комиссии/логистики/налога НЕ
 * затрагиваются: привязка «товар -> оптовик» живёт в своей таблице
 * WholesalerProduct, а товар без записи в ней — на полке «Без оптовика».
 */
export declare const wholesalersRouter: import("express-serve-static-core").Router;
export interface AppOrderLine {
    sku: string;
    name: string;
    quantity: number;
}
export declare function parseAppItems(raw: unknown): AppOrderLine[];
export declare const sameCity: (a: unknown, b: unknown) => boolean;
