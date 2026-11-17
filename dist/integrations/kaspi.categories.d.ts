export declare const KASPI_RATE_DEFAULT = 12.5;
export declare const KASPI_TOP_CATEGORY_RATE: Record<string, number>;
export interface KaspiCommissionInput {
    topCategory: string;
    leafCategory?: string;
}
/**
 * Возвращает комиссию Kaspi (С УЧЁТОМ НДС, в %) для товара по его категории.
 * Приоритет:
 *   1) Точное совпадение leaf-категории в ПОЛНОЙ таблице (4113 категорий) —
 *      самый точный вариант, покрывает практически весь ассортимент Kaspi.
 *   2) Доминирующая ставка по категории 1-го уровня (если leaf неизвестен
 *      или не нашёлся в таблице).
 *   3) Безопасный дефолт 12.5% (самая частая ставка на площадке) — так
 *      комиссия НИКОГДА не считается нулевой, даже без единой известной категории.
 */
export declare function getKaspiCommissionRate(input: KaspiCommissionInput): number;
/**
 * Сумма комиссии в тенге для конкретной продажи. Ставка из
 * getKaspiCommissionRate() — это уже готовая ставка С НДС.
 */
export declare function calcKaspiCommissionAmount(revenue: number, input: KaspiCommissionInput): number;
export interface KaspiCategoryOption {
    name: string;
    ratePct: number;
    level: 'top' | 'leaf';
    topCategory?: string;
}
/**
 * ПОЛНЫЙ список всех категорий Kaspi из официальной таблицы тарифов —
 * 4113 точных (5-го уровня) + 21 верхнего уровня. Ничего не выдумано —
 * ровно то, что есть в PDF пользователя, плюс безопасные дефолты по
 * верхним разделам (посчитаны как мода по реальным данным, не вручную).
 */
export declare function getAllKaspiCategoriesWithRates(): KaspiCategoryOption[];
