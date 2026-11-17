/**
 * Подсказки поиска My Market. Источники: категории, типы, популярные
 * (успешные) запросы покупателей и названия товаров — только из товаров,
 * которые видны в приложении. Текущий поиск товаров не затрагивается.
 */
export declare const SUGGEST_MIN_LEN = 2;
export declare const SUGGEST_MAX_LEN = 50;
export declare const SUGGEST_LIMIT = 10;
export type SuggestionType = 'category' | 'type' | 'popular' | 'product';
export interface Suggestion {
    text: string;
    type: SuggestionType;
}
export declare function normalizeSuggestQuery(raw: unknown): string;
export declare function getSearchSuggestions(rawQuery: unknown, visibleWhere: Record<string, unknown>, now?: Date): Promise<Suggestion[]>;
