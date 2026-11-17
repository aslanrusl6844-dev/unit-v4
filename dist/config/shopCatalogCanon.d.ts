/**
 * Справочник «категория → полки → типы» из приложения My Market
 * (android: CatalogShelves.kt, CATALOG_SHELVES). Это ЕДИНЫЙ источник для
 * списков «Подкатегория» и «Тип» в карточке товара в админке: продавец
 * выбирает ровно то, что покажет приложение, и товар попадает на нужную
 * плитку каталога.
 *
 * Полки (shelves) есть только у разделов, где приложение делит типы на полки
 * (Обувь, Электроника, Автотовары, Детские товары): название полки — это
 * «Подкатегория». У остальных разделов полок нет — там только типы.
 * Порядок — как в приложении. Менять вместе с CatalogShelves.kt.
 */
export interface CanonShelf {
    title: string;
    types: string[];
}
export interface CanonSection {
    shelves: CanonShelf[];
    types: string[];
}
export declare const SHOP_CATALOG_CANON: Readonly<Record<string, CanonSection>>;
/** Все типы раздела по порядку приложения, без повторов (одинаковый тип на разных полках — один). */
export declare function canonTypesOf(category: string): string[];
